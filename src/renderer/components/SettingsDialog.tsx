import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Save,
  Settings,
  Type,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { AppearanceSettings, ModelConnectionState } from "../../shared/contracts";
import { DEFAULT_MODEL_CONTEXT_WINDOW, MODEL_CONTEXT_WINDOW_OPTIONS } from "../../shared/contracts";
import { findModelProviderPreset, MODEL_PROVIDER_PRESETS } from "../../shared/model-presets";
import { AppearanceSection } from "./AppearanceSection";
import { EmbeddingConnectionSection } from "./EmbeddingConnectionSection";
import { IconButton } from "./IconButton";
import { ReaderProfileSection } from "./ReaderProfileSection";
import { WebSearchSection } from "./WebSearchSection";

type Feedback = {
  tone: "success" | "error" | "neutral";
  message: string;
};

type SettingsSection = "connection" | "appearance" | "profile";

const SECTION_TITLES: Record<SettingsSection, { title: string; description: string }> = {
  connection: { title: "模型连接", description: "对话模型与嵌入模型分开配置，凭据保存在数据目录。" },
  appearance: { title: "字体与外观", description: "调整阅读工作区的字号与顶部导航栏缩放。" },
  profile: { title: "阅读偏好", description: "你的学习背景与解释偏好，会随每个问题发给 AI。" },
};

const EMPTY_CONNECTION: ModelConnectionState = {
  protocol: "openai",
  baseUrl: "",
  model: "",
  hasApiKey: false,
  contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
};

/** 档位显示文案与值一一对应；新增档位时在此补一行，避免兜底分支错标。 */
const CONTEXT_WINDOW_LABELS: Record<number, string> = {
  262_144: "256K tokens",
  1_048_576: "1M tokens",
};

export function SettingsDialog({
  warnings = [],
  appearance,
  onAppearancePreview,
  onAppearanceSaved,
}: {
  warnings?: string[];
  appearance: AppearanceSettings;
  onAppearancePreview(settings: AppearanceSettings): void;
  onAppearanceSaved(settings: AppearanceSettings): void;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("connection");
  const [connection, setConnection] = useState(EMPTY_CONNECTION);
  const [presetId, setPresetId] = useState("custom");
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"save" | "test">();
  const [feedback, setFeedback] = useState<Feedback>();

  useEffect(() => {
    if (!open) return;
    const api = window.pdfMuse;
    if (!api) {
      setFeedback({ tone: "error", message: "模型连接仅可在 PDFMuse 桌面应用中配置。" });
      return;
    }

    let disposed = false;
    setLoading(true);
    setFeedback(undefined);
    void api.getModelConnection()
      .then((saved) => {
        if (disposed) return;
        setConnection(saved);
        setPresetId("custom");
        setApiKey("");
        setClearApiKey(false);
      })
      .catch(() => {
        if (!disposed) setFeedback({ tone: "error", message: "无法读取模型配置，请关闭设置后重试。" });
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const draft = () => {
    const preset = findModelProviderPreset(presetId);
    return {
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      model: connection.model,
      contextWindow: connection.contextWindow,
      ...(apiKey ? { apiKey } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
      // 预设带来兼容旗标（如 OpenAI 家族只认 max_completion_tokens）；自定义输入不带。
      ...(preset ? { maxTokensField: preset.maxTokensField } : {}),
    };
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = findModelProviderPreset(id);
    if (preset) {
      setConnection((current) => ({
        ...current,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        model: preset.exampleModel,
        contextWindow: preset.contextWindow,
      }));
    }
  };

  const saveConnection = async () => {
    if (!window.pdfMuse) return;
    setAction("save");
    setFeedback(undefined);
    try {
      const result = await window.pdfMuse.saveModelConnection({
        ...draft(),
        clearApiKey,
      });
      if (!result.ok) {
        setFeedback({ tone: "error", message: result.message });
        return;
      }
      setConnection(result.connection);
      setApiKey("");
      setClearApiKey(false);
      setFeedback({ tone: "success", message: "对话模型配置已保存。" });
    } catch {
      setFeedback({ tone: "error", message: "保存失败，原有配置未更改。" });
    } finally {
      setAction(undefined);
    }
  };

  const testConnection = async () => {
    if (!window.pdfMuse) return;
    setAction("test");
    setFeedback({ tone: "neutral", message: "正在连接对话模型..." });
    try {
      const result = await window.pdfMuse.testModelConnection(draft());
      setFeedback({
        tone: result.ok ? "success" : "error",
        message: result.message,
      });
    } catch {
      setFeedback({ tone: "error", message: "连接测试失败，请稍后重试。" });
    } finally {
      setAction(undefined);
    }
  };

  const busy = loading || Boolean(action);
  const heading = SECTION_TITLES[section];

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><IconButton label="设置"><Settings /></IconButton></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-dialog settings-dialog-sectioned">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{heading.title}</Dialog.Title>
              <Dialog.Description>{heading.description}</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton label="关闭设置"><X /></IconButton></Dialog.Close>
          </div>

          <nav className="settings-nav" aria-label="设置分区">
            <button
              type="button"
              className={section === "connection" ? "active" : ""}
              aria-pressed={section === "connection"}
              onClick={() => setSection("connection")}
            ><PlugZap size={15} />模型连接</button>
            <button
              type="button"
              className={section === "appearance" ? "active" : ""}
              aria-pressed={section === "appearance"}
              onClick={() => setSection("appearance")}
            ><Type size={15} />字体与外观</button>
            <button
              type="button"
              className={section === "profile" ? "active" : ""}
              aria-pressed={section === "profile"}
              onClick={() => setSection("profile")}
            ><UserRound size={15} />阅读偏好</button>
          </nav>

          <div className="settings-body">
            {warnings.length > 0 && section === "connection" && (
              <div className="settings-startup-warning" role="status">
                <AlertCircle size={15} />
                <div>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
              </div>
            )}

            {section === "connection" && (
              <>
                <section className="settings-section">
                  <div className="settings-section-heading">
                    <div>
                      <h3>对话模型</h3>
                      <span>{connection.protocol === "openai" ? "OpenAI 对话接口" : "Anthropic 消息接口"}</span>
                    </div>
                    {connection.hasApiKey && <span className="saved-key-state"><KeyRound size={13} />已保存密钥</span>}
                  </div>
                  <label>
                    常用模型商
                    <select
                      value={presetId}
                      onChange={(event) => applyPreset(event.target.value)}
                      disabled={busy}
                    >
                      <option value="custom">自定义</option>
                      {MODEL_PROVIDER_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    接口协议
                    <select
                      value={connection.protocol}
                      onChange={(event) => {
                        setPresetId("custom");
                        setConnection((current) => ({
                          ...current,
                          protocol: event.target.value === "anthropic" ? "anthropic" : "openai",
                        }));
                      }}
                      disabled={busy}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </label>
                  <label>
                    接口地址
                    <input
                      value={connection.baseUrl}
                      onChange={(event) => {
                        setPresetId("custom");
                        setConnection((current) => ({ ...current, baseUrl: event.target.value }));
                      }}
                      placeholder={connection.protocol === "openai"
                        ? "https://api.openai.com/v1"
                        : "https://api.anthropic.com"}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    模型名称
                    <input
                      value={connection.model}
                      onChange={(event) => {
                        setPresetId("custom");
                        setConnection((current) => ({ ...current, model: event.target.value }));
                      }}
                      placeholder="模型名称"
                      disabled={busy}
                    />
                  </label>
                  <label>
                    上下文窗口
                    <select
                      value={connection.contextWindow}
                      onChange={(event) => {
                        setPresetId("custom");
                        setConnection((current) => ({
                          ...current,
                          contextWindow: Number(event.target.value),
                        }));
                      }}
                      disabled={busy}
                    >
                      {MODEL_CONTEXT_WINDOW_OPTIONS.map((tokens) => (
                        <option key={tokens} value={tokens}>
                          {CONTEXT_WINDOW_LABELS[tokens] ?? `${tokens} tokens`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    API 密钥（可选）
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        if (event.target.value) setClearApiKey(false);
                      }}
                      placeholder={connection.hasApiKey ? "留空则保留已保存的密钥" : "sk-..."}
                      disabled={busy || clearApiKey}
                      autoComplete="off"
                    />
                  </label>
                  {connection.hasApiKey && (
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={clearApiKey}
                        onChange={(event) => setClearApiKey(event.target.checked)}
                        disabled={busy}
                      />
                      <span>清除已保存的 API 密钥</span>
                    </label>
                  )}
                  <p className="settings-security-note">API 密钥以明文保存在程序旁的数据目录中，复制程序目录也会复制密钥。</p>
                  <div className="settings-actions">
                    <button className="secondary-command" type="button" onClick={testConnection} disabled={busy || !window.pdfMuse}>
                      {action === "test" ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />}
                      测试连接
                    </button>
                    <button className="primary-command" type="button" onClick={saveConnection} disabled={busy || !window.pdfMuse}>
                      {action === "save" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                      保存配置
                    </button>
                  </div>
                  {feedback && (
                    <p className={`settings-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
                      {feedback.tone === "success" ? <CheckCircle2 size={14} /> : feedback.tone === "error" ? <AlertCircle size={14} /> : <LoaderCircle className="spin" size={14} />}
                      <span>{feedback.message}</span>
                    </p>
                  )}
                </section>

                <EmbeddingConnectionSection open={open} />

                <WebSearchSection open={open} />
              </>
            )}

            {section === "appearance" && (
              <AppearanceSection
                open={open}
                settings={appearance}
                onPreview={onAppearancePreview}
                onSaved={onAppearanceSaved}
              />
            )}

            {section === "profile" && <ReaderProfileSection open={open} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
