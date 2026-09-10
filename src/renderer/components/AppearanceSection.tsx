import { AlertCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_LIMITS,
  type AppearanceSettings,
} from "../../shared/contracts";

type Feedback = {
  tone: "error";
  message: string;
};

const SAVE_DEBOUNCE_MS = 500;

function sameSettings(left: AppearanceSettings, right: AppearanceSettings) {
  return left.sidebarFontSize === right.sidebarFontSize
    && left.chatFontSize === right.chatFontSize
    && left.topbarScale === right.topbarScale;
}

export function AppearanceSection({
  open,
  settings,
  onPreview,
  onSaved,
}: {
  open: boolean;
  settings: AppearanceSettings;
  onPreview(settings: AppearanceSettings): void;
  onSaved(settings: AppearanceSettings): void;
}) {
  const [draft, setDraft] = useState(settings);
  const [feedback, setFeedback] = useState<Feedback>();
  const desktop = Boolean(window.pdfMuse);
  const savedRef = useRef(settings);
  const draftRef = useRef(draft);
  const saveTimerRef = useRef(0);
  draftRef.current = draft;

  // 仅在弹窗打开时从持久化取值出发；拖动过程中 onSaved 更新的 prop 不打断当前草稿。
  useEffect(() => {
    if (!open) return;
    savedRef.current = settings;
    setDraft(settings);
    setFeedback(desktop ? undefined : { tone: "error", message: "外观设置仅可在 PDFMuse 桌面应用中配置。" });
    // settings 通过闭包读取，避免保存成功后重置正在拖动的草稿。
  }, [open, desktop]);

  const revertToSaved = useCallback(() => {
    setDraft(savedRef.current);
    onPreview(savedRef.current);
  }, [onPreview]);

  const persist = useCallback(async (target: AppearanceSettings) => {
    const api = window.pdfMuse;
    if (!api) return;
    try {
      const result = await api.saveAppearanceSettings(target);
      if (!result.ok) {
        setFeedback({ tone: "error", message: result.message });
        revertToSaved();
        return;
      }
      savedRef.current = result.settings;
      setFeedback(undefined);
      onSaved(result.settings);
    } catch {
      setFeedback({ tone: "error", message: "无法保存外观设置，已恢复到上次保存的取值。" });
      revertToSaved();
    }
  }, [onSaved, revertToSaved]);

  // 卸载（关闭弹窗/切走分区）时补存尚未落盘的改动。
  useEffect(() => () => {
    window.clearTimeout(saveTimerRef.current);
    if (!sameSettings(draftRef.current, savedRef.current)) void persist(draftRef.current);
  }, [persist]);

  const update = (patch: Partial<AppearanceSettings>) => {
    setFeedback(undefined);
    const next = { ...draftRef.current, ...patch };
    setDraft(next);
    onPreview(next);
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void persist(next), SAVE_DEBOUNCE_MS);
  };

  const resetDefaults = () => {
    update({ ...APPEARANCE_DEFAULTS });
  };

  return (
    <section className="settings-section" aria-label="字体与外观">
      <div className="settings-section-heading">
        <div>
          <h3>字体与外观</h3>
          <span>拖动滑杆立即生效，自动保存到数据目录。</span>
        </div>
      </div>
      <p className="appearance-note">影响范围：目录与缩略图、AI 助手面板、顶部导航栏。PDF 正文与书库页面不受影响。</p>

      <div className="appearance-slider">
        <div className="appearance-slider-label">
          <span>目录与缩略图字号</span>
          <span className="appearance-slider-value">{draft.sidebarFontSize}px</span>
        </div>
        <input
          type="range"
          aria-label="目录与缩略图字号"
          min={APPEARANCE_LIMITS.sidebarFontSize.min}
          max={APPEARANCE_LIMITS.sidebarFontSize.max}
          step={APPEARANCE_LIMITS.sidebarFontSize.step}
          value={draft.sidebarFontSize}
          disabled={!desktop}
          onChange={(event) => update({ sidebarFontSize: Number(event.target.value) })}
        />
      </div>

      <div className="appearance-slider">
        <div className="appearance-slider-label">
          <span>AI 助手字号</span>
          <span className="appearance-slider-value">{draft.chatFontSize}px</span>
        </div>
        <input
          type="range"
          aria-label="AI 助手字号"
          min={APPEARANCE_LIMITS.chatFontSize.min}
          max={APPEARANCE_LIMITS.chatFontSize.max}
          step={APPEARANCE_LIMITS.chatFontSize.step}
          value={draft.chatFontSize}
          disabled={!desktop}
          onChange={(event) => update({ chatFontSize: Number(event.target.value) })}
        />
      </div>

      <div className="appearance-slider">
        <div className="appearance-slider-label">
          <span>顶部导航栏缩放</span>
          <span className="appearance-slider-value">{draft.topbarScale}%</span>
        </div>
        <input
          type="range"
          aria-label="顶部导航栏缩放"
          min={APPEARANCE_LIMITS.topbarScale.min}
          max={APPEARANCE_LIMITS.topbarScale.max}
          step={APPEARANCE_LIMITS.topbarScale.step}
          value={draft.topbarScale}
          disabled={!desktop}
          onChange={(event) => update({ topbarScale: Number(event.target.value) })}
        />
      </div>

      <div className="settings-actions">
        <button className="secondary-command" type="button" onClick={resetDefaults} disabled={!desktop}>
          <RotateCcw size={15} />
          恢复默认
        </button>
      </div>

      {feedback && (
        <p className={`settings-feedback ${feedback.tone}`} role="alert">
          <AlertCircle size={14} />
          <span>{feedback.message}</span>
        </p>
      )}
    </section>
  );
}
