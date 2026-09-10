/**
 * 网络搜索模块：默认 DuckDuckGo html 端点（免 Key），配置 Tavily API Key 后优先 Tavily，
 * 单次请求失败自动降级 DDG。DDG 客户端改编自 OpenClaw 官方 duckduckgo 扩展
 * （extensions/duckduckgo/src/ddg-client.ts，本地工作区快照，见 vendor UPSTREAM.json 记录）。
 * 安全要求（ADR 0004）：固定出站主机、20s 超时、1MB 响应上限、AbortSignal 取消、结果缓存。
 */

export type WebSearchResult = { title: string; url: string; snippet: string };
export type WebSearchProvider = "duckduckgo" | "tavily";

export type WebSearchOutcome = {
  status: "ok" | "unavailable";
  provider: WebSearchProvider;
  /** Tavily 失败后降级 DDG 完成当次搜索时为 true。 */
  degraded?: boolean;
  note?: string;
  results: WebSearchResult[];
};

export type WebSearchFetch = (input: string, init?: RequestInit) => Promise<Response>;

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_RESULT_COUNT = 5;
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_ENTRIES = 64;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&",
  nbsp: " ", ndash: "-", mdash: "--", hellip: "...",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&(lt|gt|quot|apos|nbsp|ndash|mdash|hellip|amp|#\d+|#x[0-9a-f]+);/gi, (full, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return NAMED_ENTITIES[lower] ?? full;
    });
}

function stripHtml(html: string): string {
  // DDG 的命中高亮可能出现在词内，移除时不补空白。
  return html
    .replace(/<\/?b\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readHrefAttribute(tagAttributes: string): string {
  return /\bhref="([^"]*)"/i.exec(tagAttributes)?.[1] ?? "";
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(normalized);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
  } catch {
    // DDG 已返回直链时保持原值。
  }
  return rawUrl;
}

function isBotChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) return false;
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}

function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

  for (const match of html.matchAll(resultRegex)) {
    const rawUrl = readHrefAttribute(match[1] ?? "");
    const matchEnd = (match.index ?? 0) + match[0].length;
    const trailingHtml = html.slice(matchEnd);
    const nextResultIndex = trailingHtml.search(nextResultRegex);
    const scopedTrailingHtml = nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
    const title = decodeHtmlEntities(stripHtml(match[2] ?? ""));
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const snippet = decodeHtmlEntities(stripHtml(snippetRegex.exec(scopedTrailingHtml)?.[1] ?? ""));
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

async function readResponseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text;
}

export function createWebSearchModule(options: {
  loadTavilyApiKey(): Promise<string | undefined>;
  /** 生产传 Electron net.fetch（遵循系统代理）；测试注入假实现。 */
  fetchImpl?: WebSearchFetch;
}) {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const cache = new Map<string, { outcome: WebSearchOutcome; expiresAt: number }>();

  function readCache(key: string): WebSearchOutcome | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return entry.outcome;
  }

  function writeCache(key: string, outcome: WebSearchOutcome) {
    if (outcome.status !== "ok") return;
    cache.set(key, { outcome, expiresAt: Date.now() + CACHE_TTL_MS });
    while (cache.size > CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value as string);
    }
  }

  async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<WebSearchOutcome> {
    const url = new URL(DDG_HTML_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("kl", "cn-zh");
    url.searchParams.set("kp", "-1");
    const response = await doFetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!response.ok) {
      return { status: "unavailable", provider: "duckduckgo", results: [], note: `DuckDuckGo 返回 ${response.status}` };
    }
    const html = await readResponseText(response);
    if (isBotChallenge(html)) {
      return { status: "unavailable", provider: "duckduckgo", results: [], note: "DuckDuckGo 返回了反机器人验证页。" };
    }
    return { status: "ok", provider: "duckduckgo", results: parseDuckDuckGoHtml(html).slice(0, DEFAULT_RESULT_COUNT) };
  }

  async function searchTavily(query: string, apiKey: string, signal?: AbortSignal): Promise<WebSearchOutcome> {
    const response = await doFetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: DEFAULT_RESULT_COUNT, search_depth: "basic" }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Tavily 返回 ${response.status}`);
    }
    const payload = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (payload.results ?? [])
      .filter((item) => item.title && item.url)
      .map((item) => ({ title: item.title!, url: item.url!, snippet: item.content ?? "" }));
    return { status: "ok", provider: "tavily", results };
  }

  return {
    async search(rawQuery: string, signal?: AbortSignal): Promise<WebSearchOutcome> {
      const query = rawQuery.trim();
      if (!query) {
        return { status: "unavailable", provider: "duckduckgo", results: [], note: "搜索词为空。" };
      }
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const cacheKey = query.toLowerCase();
      const cached = readCache(cacheKey);
      if (cached) return cached;

      const tavilyKey = await options.loadTavilyApiKey();
      if (tavilyKey) {
        try {
          const outcome = await searchTavily(query, tavilyKey, composed);
          if (outcome.status === "ok") {
            writeCache(cacheKey, outcome);
            return outcome;
          }
          return outcome;
        } catch (error) {
          if (signal?.aborted) throw error;
          // Tavily 失败：当次降级 DDG，不中断回答。
          const fallback = await searchDuckDuckGo(query, composed);
          if (fallback.status === "ok") {
            const degraded = { ...fallback, degraded: true, note: `Tavily 失败（${error instanceof Error ? error.message : String(error)}），已降级 DuckDuckGo` };
            writeCache(cacheKey, degraded);
            return degraded;
          }
          return fallback;
        }
      }
      const outcome = await searchDuckDuckGo(query, composed);
      writeCache(cacheKey, outcome);
      return outcome;
    },
  };
}

export type WebSearchModule = ReturnType<typeof createWebSearchModule>;
