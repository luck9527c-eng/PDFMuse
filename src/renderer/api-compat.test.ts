import { describe, expect, it } from "vitest";

import { findMissingApiMethods } from "./api-compat";

function fakeApi(methods: string[]) {
  return Object.fromEntries(methods.map((method) => [method, () => undefined])) as never;
}

const ALL_METHODS = [
  "getStartupPreflight", "listLibraryBooks", "choosePdfBook", "openDroppedPdf", "openRecentLibraryBook",
  "openLibraryBook", "relocateLibraryBook", "removeLibraryBook", "deleteLibraryBookData", "unlockPdfBook",
  "updateLibraryBookState", "getModelConnection", "saveModelConnection", "testModelConnection",
  "getEmbeddingConnection", "saveEmbeddingConnection", "testEmbeddingConnection", "getBookConversation",
  "getRunDiagnostics", "clearBookConversation", "exportBookConversation", "recognizePage", "getRecognizedPage", "getBookOutline",
  "listBackgroundJobs", "scheduleBackgroundJob", "pauseBackgroundJob", "resumeBackgroundJob",
  "cancelBackgroundJob", "startAgentRun", "cancelAgentRun",
  "onAgentEvent", "onBackgroundEvent", "getReaderProfile", "saveReaderProfile", "getAppearanceSettings", "saveAppearanceSettings",
  "getWebSearchConnection", "saveWebSearchConnection",
  "getPipelineTraceEvents", "getTraceWindowSnapshot", "getTracePageBlocks", "getTraceJobs",
];

describe("findMissingApiMethods", () => {
  it("returns nothing for a complete preload api", () => {
    expect(findMissingApiMethods(fakeApi(ALL_METHODS))).toEqual([]);
  });

  it("detects methods missing from a stale preload", () => {
    const stale = ALL_METHODS.filter((method) => method !== "getAppearanceSettings" && method !== "startAgentRun");
    expect(findMissingApiMethods(fakeApi(stale))).toEqual(["startAgentRun", "getAppearanceSettings"]);
  });

  it("ignores non-function leftovers and the browser preview mode", () => {
    expect(findMissingApiMethods(undefined)).toEqual([]);
  });
});
