import * as Dialog from "@radix-ui/react-dialog";
import { LockKeyhole } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { OpenPdfBookResult } from "../../shared/contracts";

export type PasswordRequest = Extract<OpenPdfBookResult, { ok: false; code: "PASSWORD_REQUIRED" }>;

export function PasswordDialog({ request, onCancel, onUnlock }: { request?: PasswordRequest; onCancel(): void; onUnlock(password: string, remember: boolean): Promise<void> }) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPassword(""), [request?.challengeId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    try { await onUnlock(password, remember); } finally { setBusy(false); }
  };
  return (
    <Dialog.Root open={Boolean(request)} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="password-overlay" />
        <Dialog.Content className="password-dialog" aria-describedby="pdf-password-description">
          <div className="password-mark"><LockKeyhole /></div>
          <Dialog.Title>打开加密 PDF</Dialog.Title>
          <Dialog.Description id="pdf-password-description">{request?.message}</Dialog.Description>
          <form onSubmit={(event) => void submit(event)}>
            <label>PDF 密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label className="remember-password"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />记住这本书的密码</label>
            <p>记住后，密码会以明文保存在 PDFMuse 便携数据目录中。复制程序目录也会复制此密码。</p>
            <div className="password-actions"><button type="button" className="secondary-command" disabled={busy} onClick={onCancel}>取消</button><button className="primary-command" disabled={!password || busy}>{busy ? "正在验证..." : "解锁"}</button></div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
