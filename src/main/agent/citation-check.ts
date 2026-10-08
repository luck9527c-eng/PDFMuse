/**
 * 回答引用落地校验（T64，纯函数）：run 收尾时的确定性后置检查——零模型调用、零改写。
 * ① 页码声明：正文声称「第 N 页」而该页既无工具证据也未建立索引 → 未落地；
 * ② 引文片段：引号内容（归一化后）应能在声明页 ∪ 证据页的已索引文本中找到 → 找不到即未落地。
 * 已知边界（登记）：语料只取本次回答声称的出处页——引自更早对话上下文（压缩后的旧原文）的
 * 引文可能误报；校验只进诊断时间线，供长期观测回答引用可信度，不作为正确性屏障。
 */

export type CitationFinding =
  | { kind: "page_claim_unindexed"; page: number; excerpt: string }
  | { kind: "quote_not_found"; excerpt: string };

/** 「第 N 页」声明（容忍第3页/第 3 页/第3 页等空白变体；上限 4 位防误吞长数字）。 */
const PAGE_CLAIM_PATTERN = /第\s*(\d{1,4})\s*页/g;
/** 引文片段：中文直角/弯引号、英文双引号、书名号；过短片段（<6 字符）不承载可判语义，跳过。 */
const QUOTE_SPAN_PATTERN = /[「“]([^「」“”]{6,160})[」”]|"([^"\n]{6,160})"|《([^《》]{6,160})》/g;

/** 比对归一化：去空白与全部标点/符号、小写——OCR 与正文间的标点空白差异不再干扰子串匹配。 */
function normalizeForMatch(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

export function checkCitations(input: {
  answerBody: string;
  evidencePages: readonly number[];
  /** 已索引页文本；undefined = 该页未建立索引。 */
  pageText(page: number): string | undefined;
  /** 全书已索引页数（双轴审查修复）：整书零索引时页码腿全是「索引未建」而非「引用未落地」的误报，整体跳过。 */
  indexedPagesCount: number;
}): { pageClaims: number; quotes: number; findings: CitationFinding[] } {
  const body = input.answerBody;
  if (!body.trim() || input.indexedPagesCount <= 0) return { pageClaims: 0, quotes: 0, findings: [] };

  const evidence = new Set(input.evidencePages);
  const claimedPages = new Set<number>();
  for (const match of body.matchAll(PAGE_CLAIM_PATTERN)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > 0) claimedPages.add(page);
  }

  const findings: CitationFinding[] = [];
  for (const page of claimedPages) {
    if (!evidence.has(page) && input.pageText(page) === undefined) {
      findings.push({ kind: "page_claim_unindexed", page, excerpt: `第 ${page} 页` });
    }
  }

  const quotes: string[] = [];
  for (const match of body.matchAll(QUOTE_SPAN_PATTERN)) {
    const span = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (span.length >= 6) quotes.push(span);
  }
  // 语料 = 声明页 ∪ 证据页的已索引文本；全部未索引时引文腿无从比对，跳过（页码腿已兜住）。
  const corpus = [...new Set([...claimedPages, ...evidence])]
    .sort((left, right) => left - right)
    .map((page) => input.pageText(page) ?? "")
    .map(normalizeForMatch)
    .filter((text) => text.length > 0);
  if (corpus.length > 0) {
    for (const quote of quotes) {
      const normalized = normalizeForMatch(quote);
      if (normalized.length === 0) continue;
      if (!corpus.some((text) => text.includes(normalized))) {
        findings.push({ kind: "quote_not_found", excerpt: quote.length > 60 ? `${quote.slice(0, 60)}…` : quote });
      }
    }
  }

  return { pageClaims: claimedPages.size, quotes: quotes.length, findings };
}
