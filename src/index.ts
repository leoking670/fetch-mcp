import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  AUTH_TOKEN: string;
}

// ─── 工具函数：检查 robots.txt ────────────────────────────────────────────────
async function checkRobotsTxt(url: string, userAgent: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
    const res = await fetch(robotsUrl, { headers: { "User-Agent": userAgent } });
    if (!res.ok) return true; // 没有 robots.txt，默认允许
    const text = await res.text();

    // 简单解析：检查是否有针对本 UA 或 * 的 Disallow
    const lines = text.split("\n").map(l => l.trim());
    let applicable = false;
    for (const line of lines) {
      if (line.toLowerCase().startsWith("user-agent:")) {
        const agent = line.split(":")[1].trim();
        applicable = agent === "*" || userAgent.toLowerCase().includes(agent.toLowerCase());
      }
      if (applicable && line.toLowerCase().startsWith("disallow:")) {
        const disallowed = line.split(":")[1].trim();
        if (disallowed && parsed.pathname.startsWith(disallowed)) return false;
      }
    }
    return true;
  } catch {
    return true; // 解析失败，默认允许
  }
}

// ─── 工具函数：HTML → Markdown（轻量版）────────────────────────────────────────
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `${"#".repeat(+l)} ${t.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── MCP Agent ────────────────────────────────────────────────────────────────
export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Personal Fetch MCP", version: "1.0.0" });

  async init() {
    this.server.tool(
      "fetch",
      // 和官方描述保持一致
      "Fetches a URL from the internet and optionally extracts its contents as markdown. " +
      "Supports pagination via start_index for long content.",
      {
        url: z.string().url().describe("URL to fetch"),
        max_length: z.number().int().min(1).max(1000000).optional().default(20000)
          .describe("Maximum number of characters to return"),
        start_index: z.number().int().min(0).optional().default(0)
          .describe("Start content from this character index (for pagination)"),
        raw: z.boolean().optional().default(false)
          .describe("Get raw content without markdown conversion"),
      },
      async ({ url, max_length, start_index, raw }) => {
        const USER_AGENT = "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";

        // robots.txt 检查
        const allowed = await checkRobotsTxt(url, USER_AGENT);
        if (!allowed) {
          return {
            content: [{ type: "text", text: `�� Blocked by robots.txt: ${url}` }],
            isError: true,
          };
        }

        let response: Response;
        try {
          response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json,text/plain,*/*" },
            redirect: "follow",
          });
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Network error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        let content = await response.text();

        // HTML 转 Markdown（除非 raw=true 或非 HTML）
        if (!raw && contentType.includes("text/html")) {
          content = htmlToMarkdown(content);
        }

        const totalLength = content.length;
        const slice = content.substring(start_index, start_index + max_length);
        const hasMore = start_index + max_length < totalLength;

        const result = [
          `URL: ${url}`,
          `Status: ${response.status}`,
          `Content-Type: ${contentType}`,
          hasMore ? `⚠️ Showing chars ${start_index}–${start_index + max_length} of ${totalLength}. Call again with start_index=${start_index + max_length} for more.` : "",
          "---",
          slice,
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text: result }] };
      }
    );
  }
}

// ─── 入口：Bearer Token 鉴权 ──────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const token =
      request.headers.get("Authorization")?.replace("Bearer ", "") ??
      url.searchParams.get("token");

    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return MyMCP.serve("/mcp").fetch(request, env, ctx);
  },
};
