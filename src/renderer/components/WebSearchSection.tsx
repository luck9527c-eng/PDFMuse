import { AlertCircle, CheckCircle2, Globe, KeyRound, LoaderCircle, Save } from "lucide-react";
import { useEffect, useState } from "react";

type Feedback = {
  tone: "success" | "error";
  message: string;
};

const EMPTY_STATE = { tavilyApiKeySet: false };

/** 网络搜索连接：默认 DuckDuckGo 免 Key；填写 Tavily Key 后优先 Tavily，失败自动降级。 */
export function WebSearchSection({ open }: { open: boolean }) {
  const [connection, setConnection] = useState(EMPTY_STATE);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();

  useEffect(() => {
    if (!open || !window.pdfMuse) return;
    let disposed = false;
    setLoading(true);
    setFeedback(undefined);
    void window.pdfMuse.getWebSearchConnection()
      .then((saved) => {
        if (disposed) return;
        setConnection(saved);
        setApiKey("");
        setClearApiKey(false);
      })
      .catch(() => {
        if (!disposed) setFeedback({ tone: "error", message: "无法读取网络搜索配置，请关闭设置后重试。" });
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const save = async () => {
    if (!window.pdfMuse) return;
    setSaving(true);
    setFeedback(undefined);
    try {
      const result = await window.pdfMuse.saveWebSearchConnection({
        ...(apiKey.trim() ? { tavilyApiKey: apiKey.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      });
      if (!result.ok) {
        setFeedback({ tone: "error", message: result.message });
        return;
      }
      setConnection(result.connection);
      setApiKey("");
      setClearApiKey(false);
      setFeedback({ tone: "success", message: "网络搜索配置已保存。" });
    } catch {
      setFeedback({ tone: "error", message: "保存失败，原有配置未更改。" });
    } finally {
      setSaving(false);
    }
  };

  const busy = loading || saving;

  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <h3>网络搜索</h3>
          <span>AI 在书内信息不足时可联网补充资料，回答会标注来源链接。</span>
        </div>
        {connection.tavilyApiKeySet && <span className="saved-key-state"><KeyRound size={13} />已保存 Tavily 密钥</span>}
      </div>
      <label>
        Tavily API 密钥（可选）
        <input
          type="password"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            if (event.target.value) setClearApiKey(false);
          }}
          placeholder={connection.tavilyApiKeySet ? "留空则保留已保存的密钥" : "默认使用 DuckDuckGo，无需密钥"}
          disabled={busy || clearApiKey}
          autoComplete="off"
        />
      </label>
      {connection.tavilyApiKeySet && (
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={clearApiKey}
            onChange={(event) => setClearApiKey(event.target.checked)}
            disabled={busy}
          />
          <span>清除已保存的 Tavily 密钥（回到 DuckDuckGo）</span>
        </label>
      )}
      <p className="settings-security-note"><Globe size={12} /> 默认 DuckDuckGo（遵循系统代理）；填写 Tavily 密钥后优先使用，失败自动降级。搜索词会发送给对应的服务商。</p>
      <div className="settings-actions">
        <button className="primary-command" type="button" onClick={() => void save()} disabled={busy || !window.pdfMuse}>
          {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
          保存配置
        </button>
      </div>
      {feedback && (
        <p className={`settings-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.tone === "success" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          <span>{feedback.message}</span>
        </p>
      )}
    </section>
  );
}
