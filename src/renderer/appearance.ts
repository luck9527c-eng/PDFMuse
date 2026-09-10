import type { AppearanceSettings } from "../shared/contracts";

/** 外观设置到根节点 CSS 变量的映射；纯函数，便于测试。 */
export function appearanceCssVariables(settings: AppearanceSettings): Record<string, string> {
  return {
    "--sidebar-font-size": `${settings.sidebarFontSize}px`,
    "--chat-font-size": `${settings.chatFontSize}px`,
    "--topbar-scale": String(settings.topbarScale / 100),
  };
}

export function applyAppearanceSettings(settings: AppearanceSettings) {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(appearanceCssVariables(settings))) {
    style.setProperty(name, value);
  }
}
