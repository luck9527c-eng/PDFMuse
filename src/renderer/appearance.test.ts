import { describe, expect, it } from "vitest";

import { APPEARANCE_DEFAULTS } from "../shared/contracts";
import { appearanceCssVariables } from "./appearance";

describe("appearance css variables", () => {
  it("maps defaults to the current stylesheet values", () => {
    expect(appearanceCssVariables(APPEARANCE_DEFAULTS)).toEqual({
      "--sidebar-font-size": "11px",
      "--chat-font-size": "12px",
      "--topbar-scale": "1",
    });
  });

  it("maps custom settings to px sizes and a scale ratio", () => {
    expect(appearanceCssVariables({ sidebarFontSize: 15, chatFontSize: 17, topbarScale: 85 })).toEqual({
      "--sidebar-font-size": "15px",
      "--chat-font-size": "17px",
      "--topbar-scale": "0.85",
    });
  });
});
