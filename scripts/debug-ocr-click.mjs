/**
 * [DEBUG-ocr-click] 一次性诊断工具：驱动真实 Electron 应用复现"点击一个块、
 * 下面的块连着被选中 / 高亮的块是错的"。RED 判定：
 *   RED1 命中错块：点击坐标处 elementFromPoint 的块 ≠ 瞄准块
 *   RED2 选区错块：合成选区的文本 ≠ 瞄准块全文（含多块/空）
 *   RED3 文字溢出：瞄准块 scrollHeight 明显超出 clientHeight（拟合文字溢出盒子，
 *        选区高亮会画到后续块的区域上——"下面的块连着被选中"的视觉来源）
 * 用完即删或移入明确标记的调试位置。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("no port")));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPage(electronLogRef, fallbackPort) {
  const deadline = Date.now() + 120_000;
  let lastPort = "none";
  let lastError = "从未尝试";
  while (Date.now() < deadline) {
    // Chromium 可能改绑端口：以 "DevTools listening" 行里的真实端口为准。
    const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(electronLogRef.log);
    const port = match ? Number(match[1]) : fallbackPort;
    if (port !== lastPort) { lastPort = port; }
    try {
      // 本机 Node fetch 到 127.0.0.1 的 DevTools 端口会 ECONNREFUSED（疑似代理环境干扰），
      // curl 直连已验证可用——改用 curl 轮询。
      const result = spawnSync("curl.exe", ["-s", "--noproxy", "*", "--max-time", "3", `http://127.0.0.1:${port}/json`], { encoding: "utf8" });
      if (result.status !== 0 || !result.stdout) {
        lastError = result.stderr?.slice(0, 80) || "curl empty output";
        continue;
      }
      const targets = JSON.parse(result.stdout);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return { wsUrl: page.webSocketDebuggerUrl, port };
      lastError = `no page target，目标列表：${JSON.stringify(targets.map((t) => ({ type: t.type, url: (t.url ?? "").slice(0, 60) }))).slice(0, 300)}`;
    } catch (error) {
      lastError = String(error?.cause?.code ?? error?.cause ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Electron 未暴露渲染页面（30s，端口：${lastPort}，最后一次错误：${lastError}）。`);
}

function command(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("eval timeout")); }, 15_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolve(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("CDP 连接失败")));
  });
}

async function evaluate(webSocketUrl, expression) {
  const result = await command(webSocketUrl, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value;
}

async function waitForSpans(webSocketUrl) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const count = await evaluate(webSocketUrl, `document.querySelectorAll('.page .ocr-text-layer span').length`);
    if (count > 0) return count;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const diagnostics = await evaluate(webSocketUrl, `JSON.stringify({
    book: document.querySelector('.book-title, [class*=title]')?.textContent ?? '',
    pdfPages: document.querySelectorAll('.page').length,
    pdfMuseApi: window.pdfMuse ? Object.keys(window.pdfMuse).slice(0, 30) : null,
  })`).catch(() => "diag failed");
  throw new Error(`90 秒内未出现 OCR 文字层。诊断：${diagnostics}`);
}

const port = await reservePort();
const profile = await mkdtemp(path.join(os.tmpdir(), "pdfmuse-debug-click-"));
const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const logRef = { log: "" };
  const app = spawn(electronExecutable, [".", `--remote-debugging-port=${port}`, "--headless", "--disable-gpu", `--user-data-dir=${profile}`], {
    cwd: projectRoot,
    env: { ...globalThis.process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", VITE_DEV_SERVER_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stderr.on("data", (chunk) => { logRef.log += chunk; });
  app.stdout.on("data", (chunk) => { logRef.log += chunk; });
  app.on("error", (error) => { logRef.log += `\n[spawn error] ${error}`; });
  app.on("exit", (code) => { logRef.log += `\n[exit code=${code}]`; });
  setTimeout(() => { if (app.exitCode === null && !app.killed) logRef.log += `\n[still alive pid=${app.pid}]`; }, 3000);
try {
  const { wsUrl } = await waitForPage(logRef, port).catch((error) => { throw new Error(`${error.message}\n[electron log 尾部] ${logRef.log.slice(-800)}`); });
  console.log(`[loop] ws 地址：${wsUrl}`);
  // 视口设为真实应用尺寸，几何才有代表性。
  await command(wsUrl, "Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const spanCount = await waitForSpans(wsUrl);
  let aim = null;
  let aimError = null;
  // 启动期 pdf.js 反复重渲染会拆掉重建文字层：aim 需要重试到层稳定。
  for (let attempt = 0; attempt < 20 && !aim; attempt += 1) {
    try {
      aim = await evaluate(wsUrl, `(() => {
    const viewportH = window.innerHeight;
    const spans = Array.from(document.querySelectorAll('.page .ocr-text-layer span'))
      .filter((s) => { const r = s.getBoundingClientRect(); return r.width >= 100 && r.height >= 12 && r.top + r.height / 2 > 150; })
      .sort((a, b) => b.textContent.length - a.textContent.length);
    const span = spans[0];
    if (!span) throw new Error('未找到任何可点块。采样：' + JSON.stringify({ viewportH, all: Array.from(document.querySelectorAll('.page .ocr-text-layer span')).slice(0, 10).map((s) => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), len: s.textContent.length, text: s.textContent.slice(0, 12) }; }) }));
    const r = span.getBoundingClientRect();
    return { ok: true, text: span.textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      rect: { w: r.width, h: r.height }, clientH: span.clientHeight, scrollH: span.scrollHeight,
      offsetH: span.offsetHeight, whiteSpace: getComputedStyle(span).whiteSpace, overflow: getComputedStyle(span).overflow };
    })()`);
    } catch (error) { aimError = String(error).slice(0, 260); }
    if (aim?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!aim) throw new Error(`20 次重试后仍无可点块。最后一次原因：${aimError ?? "未知"}`);
  console.log(`[loop] 块数=${spanCount} 瞄准块文本=${aim.text.slice(0, 24)}… 中心=(${aim.cx.toFixed(0)},${aim.cy.toFixed(0)}) 盒=${aim.rect.w.toFixed(0)}×${aim.rect.h.toFixed(0)} clientH=${aim.clientH} scrollH=${aim.scrollH} whiteSpace=${aim.whiteSpace} overflow=${aim.overflow}`);

  for (const [type, pressed] of [["mousePressed", true], ["mouseReleased", false]]) {
    await command(wsUrl, "Input.dispatchMouseEvent", { type, x: aim.cx, y: aim.cy, button: "left", clickCount: 1, buttons: pressed ? 1 : 0 });
  }
  await new Promise((resolve) => setTimeout(resolve, 800));

  const after = await evaluate(wsUrl, `JSON.stringify((() => {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const container = range ? (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement) : null;
    const selSpan = container?.closest('.ocr-text-layer span');
    const aimEl = document.elementFromPoint(${aim.cx}, ${aim.cy});
    const aimSpan = aimEl?.closest('.ocr-text-layer span');
    const all = Array.from(document.querySelectorAll('.page .ocr-text-layer span'));
    const aimIdx = all.findIndex((s) => s.textContent === ${JSON.stringify(aim.text)});
    const afterIdx = all.findIndex((s) => s === aimSpan);
    return {
      selectionText: sel ? sel.toString() : null,
      selectionSpanText: selSpan?.textContent ?? null,
      elementFromPointText: aimSpan?.textContent ?? null,
      elementFromPointIsSpan: Boolean(aimSpan),
      aimIdx, afterIdx,
      selectionLength: sel ? sel.toString().length : 0,
      aimTextLength: ${JSON.stringify(aim.text)}.length,
    };
  })())`, );
  const facts = JSON.parse(after);
  console.log(`[loop] 点击后：命中块序号=${facts.afterIdx}（瞄准块序号=${facts.aimIdx}） 选区长度=${facts.selectionLength}（瞄准块全文长度=${facts.aimTextLength}） 选区所属块=${facts.selectionSpanText?.slice(0, 24) ?? "无"}`);

  const verdicts = [];
  verdicts.push({ name: "RED1 命中错块", red: facts.elementFromPointText !== aim.text, detail: `elementFromPoint=${facts.elementFromPointText?.slice(0, 20) ?? "null"}` });
  verdicts.push({ name: "RED2 选区错块/多块", red: facts.selectionSpanText !== aim.text || facts.selectionLength !== facts.aimTextLength, detail: `选区所属块=${facts.selectionSpanText?.slice(0, 20) ?? "null"} 长度=${facts.selectionLength}/${facts.aimTextLength}` });
  verdicts.push({ name: "RED3 拟合文字溢出盒子", red: aim.overflow !== "hidden" || aim.scrollH > aim.clientH * 1.5, detail: `scrollH=${aim.scrollH} clientH=${aim.clientH} overflow=${aim.overflow}（hidden 时溢出被裁在盒内，不再污染相邻块）` });
  let failed = false;
  for (const verdict of verdicts) {
    console.log(`[loop] ${verdict.red ? "RED " : "PASS"} ${verdict.name} — ${verdict.detail}`);
    if (verdict.red) failed = true;
  }
  console.log(failed ? "[loop] 判定：RED（复现用户症状）" : "[loop] 判定：GREEN（未复现）");
  process.exitCode = failed ? 1 : 0;
} finally {
  app.kill();
  if (process.platform === "win32" && app.pid) spawnSync("taskkill", ["/pid", String(app.pid), "/t", "/f"], { stdio: "ignore" });
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
