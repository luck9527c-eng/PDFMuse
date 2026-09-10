import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APPEARANCE_DEFAULTS } from "../shared/contracts.js";
import { createAppearanceSettingsModule } from "./appearance-settings.js";

describe("appearance settings module", () => {
  let dataHome: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-appearance-"));
  });

  afterEach(async () => {
    await rm(dataHome, { recursive: true, force: true });
  });

  it("returns defaults before first save", async () => {
    const module = createAppearanceSettingsModule(dataHome);
    expect(await module.get()).toEqual(APPEARANCE_DEFAULTS);
  });

  it("saves and reloads settings", async () => {
    const module = createAppearanceSettingsModule(dataHome);
    const result = await module.save({ sidebarFontSize: 14, chatFontSize: 16, topbarScale: 110 });
    expect(result).toEqual({ ok: true, settings: { sidebarFontSize: 14, chatFontSize: 16, topbarScale: 110 } });

    const reloaded = await createAppearanceSettingsModule(dataHome).get();
    expect(reloaded).toEqual({ sidebarFontSize: 14, chatFontSize: 16, topbarScale: 110 });
  });

  it("rejects out-of-range or invalid input", async () => {
    const module = createAppearanceSettingsModule(dataHome);
    expect((await module.save({ sidebarFontSize: 9, chatFontSize: 12, topbarScale: 100 })).ok).toBe(false);
    expect((await module.save({ sidebarFontSize: 17, chatFontSize: 12, topbarScale: 100 })).ok).toBe(false);
    expect((await module.save({ sidebarFontSize: 11, chatFontSize: 19, topbarScale: 100 })).ok).toBe(false);
    expect((await module.save({ sidebarFontSize: 11, chatFontSize: 12, topbarScale: 84 })).ok).toBe(false);
    expect((await module.save({ sidebarFontSize: 11.5, chatFontSize: 12, topbarScale: 100 })).ok).toBe(false);
    expect((await module.save(null)).ok).toBe(false);
    expect((await module.save({ sidebarFontSize: "大", chatFontSize: 12, topbarScale: 100 })).ok).toBe(false);
  });

  it("keeps a damaged settings file untouched and behaves as defaults", async () => {
    const settingsPath = path.join(dataHome, "appearance-settings.json");
    await writeFile(settingsPath, "{ not json", "utf8");
    const module = createAppearanceSettingsModule(dataHome);
    expect(await module.get()).toEqual(APPEARANCE_DEFAULTS);
    expect(await readFile(settingsPath, "utf8")).toBe("{ not json");
    const saved = await module.save({ sidebarFontSize: 13, chatFontSize: 15, topbarScale: 95 });
    expect(saved.ok).toBe(true);
    expect(await createAppearanceSettingsModule(dataHome).get()).toEqual({ sidebarFontSize: 13, chatFontSize: 15, topbarScale: 95 });
  });
});
