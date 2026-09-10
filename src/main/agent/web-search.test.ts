import { describe, expect, it } from "vitest";

import { createWebSearchModule, type WebSearchFetch } from "./web-search.js";

function htmlResponse(html: string, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => html } as unknown as Response;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response;
}

const DDG_HTML = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fauthor%3Fq%3D1">唐朔飞 &lt;作者&gt;简介</a>
  <a class="result__snippet">《计算机组成原理》的作者<b>唐朔飞</b>，哈尔滨工业大学教授&hellip;</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.com/direct">出版社官方页面</a>
  <a class="result__snippet">高等教育出版社出版的经典教材。</a>
</div>`;

describe("web search module", () => {
  it("parses duckduckgo html results with entity decoding and uddg unwrap", async () => {
    const calls: string[] = [];
    const fetchImpl: WebSearchFetch = async (input) => {
      calls.push(String(input));
      return htmlResponse(DDG_HTML);
    };
    const module = createWebSearchModule({ loadTavilyApiKey: async () => undefined, fetchImpl });
    const outcome = await module.search("计算机组成原理 作者");
    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("duckduckgo");
    expect(outcome.results[0]).toMatchObject({
      title: "唐朔飞 <作者>简介",
      url: "https://example.com/author?q=1",
      snippet: expect.stringContaining("哈尔滨工业大学"),
    });
    expect(outcome.results[1]?.url).toBe("https://example.com/direct");
    expect(calls[0]).toContain("html.duckduckgo.com/html");
    expect(calls[0]).toContain("q=");
  });

  it("prefers tavily when a key is configured", async () => {
    const fetchImpl: WebSearchFetch = async (input) => {
      expect(String(input)).toBe("https://api.tavily.com/search");
      return jsonResponse({ results: [{ title: "Tavily 结果", url: "https://t.example.com/a", content: "摘要" }] });
    };
    const module = createWebSearchModule({ loadTavilyApiKey: async () => "tvly-key", fetchImpl });
    const outcome = await module.search("作者");
    expect(outcome).toMatchObject({ status: "ok", provider: "tavily" });
    expect(outcome.results[0]?.title).toBe("Tavily 结果");
  });

  it("degrades to duckduckgo when tavily fails for the request", async () => {
    const endpoints: string[] = [];
    const fetchImpl: WebSearchFetch = async (input) => {
      const url = String(input);
      endpoints.push(url);
      if (url.includes("tavily")) return jsonResponse({ detail: "invalid" }, 401);
      return htmlResponse(DDG_HTML);
    };
    const module = createWebSearchModule({ loadTavilyApiKey: async () => "tvly-bad", fetchImpl });
    const outcome = await module.search("作者");
    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("duckduckgo");
    expect(outcome.degraded).toBe(true);
    expect(outcome.note).toContain("Tavily 失败");
    expect(endpoints).toHaveLength(2);
  });

  it("caches ok results and skips the network on repeat queries", async () => {
    let fetchCalls = 0;
    const fetchImpl: WebSearchFetch = async () => {
      fetchCalls += 1;
      return htmlResponse(DDG_HTML);
    };
    const module = createWebSearchModule({ loadTavilyApiKey: async () => undefined, fetchImpl });
    await module.search("同一查询");
    await module.search(" 同一查询 ");
    expect(fetchCalls).toBe(1);
  });

  it("reports unavailable on bot challenge pages and empty queries", async () => {
    const challenged = createWebSearchModule({
      loadTavilyApiKey: async () => undefined,
      fetchImpl: async () => htmlResponse('<form id="challenge-form"></form>'),
    });
    expect((await challenged.search("词")).status).toBe("unavailable");
    const module = createWebSearchModule({ loadTavilyApiKey: async () => undefined, fetchImpl: async () => htmlResponse(DDG_HTML) });
    expect((await module.search("   ")).status).toBe("unavailable");
  });
});
