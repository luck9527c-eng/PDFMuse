import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Save,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { ModelConnectionState } from "../../shared/contracts";
import { IconButton } from "./IconButton";

type Feedback = {
  tone: "success" | "error" | "neutral";
  message: string;
};

const EMPTY_CONNECTION: ModelConnectionState = {
  protocol: "openai",
  baseUrl: "",
  model: "",
  hasApiKey: false,
};

export function SettingsDialog({ warnings = [] }: { warnings?: string[] }) {
  const [open, setOpen] = useState(false);
  const [connection, setConnection] = useState(EMPTY_CONNECTION);
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

  const draft = () => ({
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    ...(apiKey ? { apiKey } : {}),
    ...(clearApiKey ? { clearApiKey: true } : {}),
  });

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

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><IconButton label="模型与阅读设置"><Settings /></IconButton></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-dialog">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>模型连接</Dialog.Title>
              <Dialog.Description>对话模型与嵌入模型分开配置，凭据保存在数据目录。</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton label="关闭设置"><X /></IconButton></Dialog.Close>
          </div>

          {warnings.length > 0 && (
            <div className="settings-startup-warning" role="status">
              <AlertCircle size={15} />
              <div>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
            </div>
          )}

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>对话模型</h3>
                <span>{connection.protocol === "openai" ? "OpenAI 对话接口" : "Anthropic 消息接口"}</span>
              </div>
              {connection.hasApiKey && <span className="saved-key-state"><KeyRound size={13} />已保存密钥</span>}
            </div>
            <label>
              接口协议
              <select
                value={connection.protocol}
                onChange={(event) => setConnection((current) => ({
                  ...current,
                  protocol: event.target.value === "anthropic" ? "anthropic" : "openai",
                }))}
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
                onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))}
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
                onChange={(event) => setConnection((current) => ({ ...current, model: event.target.value }))}
                placeholder="模型名称"
                disabled={busy}
              />
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

          <section className="settings-section settings-section-disabled">
            <h3>嵌入模型</h3>
            <p>嵌入模型连接将在下一个任务中接入。</p>
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
