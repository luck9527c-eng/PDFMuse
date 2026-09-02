import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { EmbeddingConnectionState } from "../../shared/contracts";

type Feedback = {
  tone: "success" | "error" | "neutral";
  message: string;
};

const EMPTY_CONNECTION: EmbeddingConnectionState = {
  baseUrl: "",
  model: "",
  hasApiKey: false,
};

export function EmbeddingConnectionSection({ open }: { open: boolean }) {
  const [connection, setConnection] = useState(EMPTY_CONNECTION);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"save" | "test">();
  const [feedback, setFeedback] = useState<Feedback>();

  useEffect(() => {
    if (!open || !window.pdfMuse) return;
    let disposed = false;
    setLoading(true);
    setFeedback(undefined);
    void window.pdfMuse.getEmbeddingConnection()
      .then((saved) => {
        if (disposed) return;
        setConnection(saved);
        setApiKey("");
        setClearApiKey(false);
      })
      .catch(() => {
        if (!disposed) setFeedback({ tone: "error", message: "无法读取嵌入模型配置，请关闭设置后重试。" });
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const draft = () => ({
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
      const result = await window.pdfMuse.saveEmbeddingConnection(draft());
      if (!result.ok) {
        setFeedback({ tone: "error", message: result.message });
        return;
      }
      setConnection(result.connection);
      setApiKey("");
      setClearApiKey(false);
      setFeedback({ tone: "success", message: "嵌入模型配置已保存。" });
    } catch {
      setFeedback({ tone: "error", message: "保存失败，原有嵌入模型配置未更改。" });
    } finally {
      setAction(undefined);
    }
  };

  const testConnection = async () => {
    if (!window.pdfMuse) return;
    setAction("test");
    setFeedback({ tone: "neutral", message: "正在连接嵌入模型..." });
    try {
      const result = await window.pdfMuse.testEmbeddingConnection(draft());
      setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
    } catch {
      setFeedback({ tone: "error", message: "连接测试失败，请稍后重试。" });
    } finally {
      setAction(undefined);
    }
  };

  const busy = loading || Boolean(action);

  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><h3>嵌入模型</h3><span>OpenAI 兼容嵌入接口</span></div>
        {connection.hasApiKey && <span className="saved-key-state"><KeyRound size={13} />已保存密钥</span>}
      </div>
      <label>
        接口地址
        <input
          value={connection.baseUrl}
          onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder="https://api.openai.com/v1"
          disabled={busy}
        />
      </label>
      <label>
        模型名称
        <input
          value={connection.model}
          onChange={(event) => setConnection((current) => ({ ...current, model: event.target.value }))}
          placeholder="嵌入模型名称"
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
          测试嵌入连接
        </button>
        <button className="primary-command" type="button" onClick={saveConnection} disabled={busy || !window.pdfMuse}>
          {action === "save" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
          保存嵌入配置
        </button>
      </div>
      {feedback && (
        <p className={`settings-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.tone === "success" ? <CheckCircle2 size={14} /> : feedback.tone === "error" ? <AlertCircle size={14} /> : <LoaderCircle className="spin" size={14} />}
          <span>{feedback.message}</span>
        </p>
      )}
    </section>
  );
}
