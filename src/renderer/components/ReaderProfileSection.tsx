import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, UserRound, Save } from "lucide-react";

type Feedback = {
  tone: "success" | "error";
  message: string;
};

const PLACEHOLDER = [
  "例如：",
  "我是软件工程师，熟悉 Java 但刚接触分布式系统。",
  "偏好先给结论再展开推理；解释术语时给一个具体例子。",
  "数学推导需要逐步说明。",
].join("\n");

/** Reader Profile：全局学习背景与解释偏好，只由 Reader 修改，AI 不得写入。 */
export function ReaderProfileSection({ open }: { open: boolean }) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();

  useEffect(() => {
    if (!open) return;
    const api = window.pdfMuse;
    if (!api) {
      setFeedback({ tone: "error", message: "阅读偏好仅可在 PDFMuse 桌面应用中编辑。" });
      return;
    }
    let disposed = false;
    setLoading(true);
    setFeedback(undefined);
    void api.getReaderProfile()
      .then((profile) => {
        if (disposed) return;
        setContent(profile.content);
        setSavedContent(profile.content);
      })
      .catch(() => {
        if (!disposed) setFeedback({ tone: "error", message: "无法读取阅读偏好，请关闭设置后重试。" });
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
      const result = await window.pdfMuse.saveReaderProfile({ content });
      if (!result.ok) {
        setFeedback({ tone: "error", message: result.message });
        return;
      }
      setContent(result.profile.content);
      setSavedContent(result.profile.content);
      setFeedback({ tone: "success", message: "阅读偏好已保存，将影响后续所有回答。" });
    } catch {
      setFeedback({ tone: "error", message: "保存失败，原有偏好未更改。" });
    } finally {
      setSaving(false);
    }
  };

  const busy = loading || saving;
  const dirty = content !== savedContent;

  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <h3>阅读偏好（Reader Profile）</h3>
          <span>全局学习背景与解释偏好，适用于所有书籍</span>
        </div>
      </div>
      <label>
        偏好描述
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={PLACEHOLDER}
          rows={5}
          disabled={busy}
        />
      </label>
      <p className="settings-security-note">
        阅读偏好只由你修改并保存在数据目录；AI 只会读取它来调整回答的深度和举例方式，不会改写它。
      </p>
      <div className="settings-actions">
        <button
          className="primary-command"
          type="button"
          onClick={save}
          disabled={busy || !window.pdfMuse || !dirty}
        >
          {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
          保存阅读偏好
        </button>
      </div>
      {feedback && (
        <p className={`settings-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.tone === "success" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          <span>{feedback.message}</span>
        </p>
      )}
      {loading && <p className="settings-feedback neutral"><LoaderCircle className="spin" size={14} /><span>正在读取阅读偏好...</span></p>}
      {!loading && !savedContent && <p className="profile-hint"><UserRound size={13} />尚未设置阅读偏好；设置后所有书籍的回答都会参考它。</p>}
    </section>
  );
}
