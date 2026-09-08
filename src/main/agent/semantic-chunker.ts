import { estimateStringChars, estimateTokensFromChars } from "./openclaw-core.js";

const MIN_CHUNK_TOKENS = 500;
const MAX_CHUNK_TOKENS = 800;
const OVERLAP_TOKENS = 96;
const CHUNK_VERSION = "v2";

type Boundary = { position: number; priority: number };

function estimateTokens(text: string) {
  return estimateTokensFromChars(estimateStringChars(text));
}

function normalizePageText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHeading(line: string) {
  const value = line.trim();
  if (!value || value.length > 80) return false;
  return /^(?:第[一二三四五六七八九十百零〇0-9]+[章节篇部]|chapter\s+\w+|\d+(?:\.\d+){0,3}\s+\S)/i.test(value);
}

function collectBoundaries(text: string) {
  const boundaries: Boundary[] = [];
  for (const match of text.matchAll(/\n\s*\n/g)) {
    boundaries.push({ position: match.index, priority: 4 });
  }
  for (const match of text.matchAll(/[^\n]+/g)) {
    const line = match[0];
    const start = match.index;
    const end = start + line.length;
    if (looksLikeHeading(line)) {
      if (start > 0) boundaries.push({ position: start, priority: 5 });
      boundaries.push({ position: end, priority: 3 });
    } else if (end < text.length) {
      boundaries.push({ position: end, priority: 2 });
    }
  }
  for (const match of text.matchAll(/[。！？!?；;]|\.(?=\s|$)/g)) {
    boundaries.push({ position: match.index + match[0].length, priority: 1 });
  }
  return boundaries;
}

function endWithinBudget(text: string, start: number, budget: number) {
  let low = start + 1;
  let high = text.length;
  let result = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(start, middle)) <= budget) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function startForOverlap(text: string, end: number) {
  let low = 0;
  let high = end;
  let result = end;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(middle, end)) <= OVERLAP_TOKENS) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return result;
}

export function chunkPageText(source: string, page: number) {
  const text = normalizePageText(source);
  if (!text) return [];
  if (estimateTokens(text) <= MAX_CHUNK_TOKENS) {
    return [{ id: `${CHUNK_VERSION}:0`, text, page }];
  }

  const boundaries = collectBoundaries(text);
  const chunks: Array<{ id: string; text: string; page: number }> = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = endWithinBudget(text, start, MAX_CHUNK_TOKENS);
    if (hardEnd >= text.length) {
      const tail = text.slice(start).trim();
      if (tail) chunks.push({ id: `${CHUNK_VERSION}:${chunks.length}`, text: tail, page });
      break;
    }

    const minimumEnd = endWithinBudget(text, start, MIN_CHUNK_TOKENS);
    const candidates = boundaries.filter((boundary) => boundary.position >= minimumEnd && boundary.position <= hardEnd);
    const priority = Math.max(0, ...candidates.map((candidate) => candidate.priority));
    const preferred = candidates.filter((candidate) => candidate.priority === priority);
    const end = preferred.length > 0
      ? Math.max(...preferred.map((candidate) => candidate.position))
      : hardEnd;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push({ id: `${CHUNK_VERSION}:${chunks.length}`, text: chunk, page });
    const nextStart = startForOverlap(text, end);
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}
