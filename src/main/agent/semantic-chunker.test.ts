import { describe, expect, it } from "vitest";

import { chunkPageText } from "./semantic-chunker.js";

describe("semantic page chunking", () => {
  it("keeps a short page as one versioned chunk", () => {
    expect(chunkPageText("第一章\n这是简短的正文。", 7)).toEqual([
      { id: "v2:0", page: 7, text: "第一章\n这是简短的正文。" },
    ]);
  });

  it("prefers a paragraph boundary and carries limited overlap into the next chunk", () => {
    const firstParagraph = `${"甲".repeat(520)}。`;
    const secondParagraph = `${"乙".repeat(420)}。`;
    const chunks = chunkPageText(`${firstParagraph}\n\n${secondParagraph}`, 3);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe(firstParagraph);
    expect(chunks[1]?.text.endsWith(secondParagraph)).toBe(true);
    expect(chunks[1]?.text.startsWith("甲")).toBe(true);
    expect(chunks[1]?.page).toBe(3);
  });

  it("prefers sentence endings when no paragraph boundary is available", () => {
    const firstSentence = `${"甲".repeat(540)}。`;
    const chunks = chunkPageText(`${firstSentence}${"乙".repeat(360)}。`, 2);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe(firstSentence);
    expect(chunks[1]?.text.endsWith(`${"乙".repeat(360)}。`)).toBe(true);
  });

  it("hard-splits uninterrupted text while retaining roughly twelve percent overlap", () => {
    const chunks = chunkPageText("长".repeat(1_600), 9);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 800)).toBe(true);
    expect(chunks[0]?.text.slice(-96)).toBe(chunks[1]?.text.slice(0, 96));
  });
});
