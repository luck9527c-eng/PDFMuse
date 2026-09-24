/**
 * 重复/循环检测器（T50 纯模块）：指纹、分类、链计数、门槛与窗口滑动，全部无 I/O。
 * 三层管线（形状定案）：原始载荷 →（哈希/比对/计链）→ 交付形态（全文 | Result Stub）→ 注解 → 落库。
 * 哈希只做候选索引；「byte-identical」断言一律经字节比对确认，因此哈希碰撞不可能误判、
 * 相同字节不可能漏判（哈希是确定性函数）。注解层（额度回显等逐次变化的文本）不进哈希。
 */

/** 指纹窗口容量：本问最近 8 条（FIFO），滑出即遗忘（再遇视为合法复查、链重计）。 */
export const FINGERPRINT_WINDOW_SIZE = 8;
/** Result Stub 替换门槛：总载荷（文本字符 + 图块字节）≥512 才值得省；常量形空结果不得误杀。 */
export const STUB_MIN_PAYLOAD = 512;
/** stub 指向参数的预览长度：定位 + 重取钥匙。 */
const ARGS_PREVIEW_CHARS = 120;

/** 指纹窗口条目：一次已执行工具调用的指纹与字节比对依据。error/超时/被拒结果永不入窗。 */
export type FingerprintEntry = {
  callId: string;
  toolName: string;
  /** 参数保序序列化（不排序键、不排序数组——[1,2] 与 [2,1] 是不同调用）。 */
  argsKey: string;
  /** 被指向那次参数的前 120 字符（空白归一）。 */
  argsPreview: string;
  resultHash: string;
  /** 第一层原始载荷的文本部分，供字节比对。 */
  payloadText: string;
  /** 图块 base64 引用（与模型上下文共享同一字符串，字节比对按引用/逐字节相等）。 */
  imageRefs: string[];
};

/** 第一层原始载荷：文本块拼接 + 图块字节（注解层不在此）。 */
export type ToolPayload = {
  text: string;
  images: string[];
};

export type RepeatVerdict = {
  /** new-info=拿到新信息开新链；param-loop=同参同果（原地打转）；result-loop=异参同果（工具给不出新信息）。 */
  chainKind: "new-info" | "param-loop" | "result-loop";
  /** e = 窗口内同（工具, 结果哈希且字节相同）条目数 + 1。 */
  e: number;
  /** 措辞里的 N = 同参条目数 + 1（混链时措辞不撒谎）。 */
  repeatCount: number;
  delivery: "full" | "stub";
  /** 交付形态为 Result Stub 时的指针正文。 */
  stubText?: string;
  /** 警告（文案 4）：参数循环第 3 拍。 */
  warningText?: string;
  /** 强制收尾（文案 5/6）：参数循环第 4 拍 / 结果循环第 3 拍。 */
  finalizeText?: string;
};

/** 参数保序序列化；不可序列化值退化为 String() 保证键存在。 */
export function argsKeyOf(params: unknown): string {
  try {
    return JSON.stringify(params ?? {}) ?? String(params);
  } catch {
    return String(params);
  }
}

/** 参数预览：空白归一为单段后截前 120 字符。 */
export function argsPreviewOf(argsKey: string): string {
  return argsKey.replace(/\s+/g, " ").trim().slice(0, ARGS_PREVIEW_CHARS);
}

/** FNV-1a 32 位：只作候选索引，命中后由字节比对确认。 */
function fnv1a(value: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 载荷哈希：文本 + 图块字节（同一字节源恒同）。 */
export function hashPayload(payload: ToolPayload): string {
  return `${fnv1a(payload.text)}-${fnv1a(payload.images.join("\x00"), 0x9dc5811c)}`;
}

/** 总载荷字符数：文本字符 + 图块字节（base64 折算）。 */
export function payloadChars(payload: ToolPayload): number {
  const imageBytes = payload.images.reduce((total, data) => total + Math.floor(data.length * 3 / 4), 0);
  return payload.text.length + imageBytes;
}

function byteIdentical(entry: FingerprintEntry, payload: ToolPayload): boolean {
  if (entry.payloadText !== payload.text || entry.imageRefs.length !== payload.images.length) return false;
  return entry.imageRefs.every((ref, index) => ref === payload.images[index]);
}

/** Result Stub 模板（英文原文照收）；resultLoop 变体用于参数不同语境，hasImages 追加重取指引行。 */
export function resultStubText(input: {
  pointedTo: FingerprintEntry;
  resultLoop: boolean;
  hasImages: boolean;
}): string {
  const entry = input.pointedTo;
  const base = input.resultLoop
    ? `this result is byte-identical to the ${entry.toolName} result earlier this turn (tool_call_id ${entry.callId}) even with different arguments. The tool has no more to give. Refer to that result. Args of that call: ${entry.argsPreview}`
    : `this result is byte-identical to the ${entry.toolName} result earlier this turn (tool_call_id ${entry.callId}). Refer to that result; it has not changed. Args: ${entry.argsPreview}`;
  return input.hasImages
    ? `${base} ...includes page images; re-call read_page_image with the same pages to fetch them.`
    : base;
}

/** 警告（文案 4）：参数循环第 3 拍，「第 N 次」按同参条目数 + 1。 */
export function repeatWarningText(repeatCount: number): string {
  return `这是第 ${repeatCount} 次一模一样的调用，结果一模一样。别重复了——换参数、换工具，或直接用手头的结果。`;
}

/** 强制收尾（文案 5 · 参数循环）：「第 {N} 次」模板化。 */
export function paramLoopFinalizeText(repeatCount: number): string {
  return `你已第 ${repeatCount} 次重复同一调用，结果始终没有变化。不要再调用任何工具，基于已获取的信息给出最终回答，并说明哪些部分未完成。`;
}

/** 强制收尾（文案 6 · 结果循环）。 */
export const RESULT_LOOP_FINALIZE_TEXT =
  "你已连续多次调用却拿不到新信息，结果始终没有变化。不要再调用任何工具，基于已获取的信息给出最终回答，并说明哪些部分未完成。";

/**
 * 分类与节拍判定（规格节拍表）：
 * - 参数循环：e=1 全文；e=2 载荷 ≥512 静默 stub 否则全文；e=3 stub+警告；e≥4 强制收尾。
 * - 结果循环（候选要求载荷 ≥512）：e=1 全文；e=2 静默 stub；e≥3 强制收尾。
 * - 同参异果 → new-info 开新链全文；<512 异参同果不入结果链（全文照给）。
 */
export function detectRepeat(input: {
  window: ReadonlyArray<FingerprintEntry>;
  toolName: string;
  callId: string;
  params: unknown;
  payload: ToolPayload;
}): RepeatVerdict {
  const argsKey = argsKeyOf(input.params);
  const chain = input.window.filter(
    (entry) => entry.toolName === input.toolName && entry.resultHash === hashPayload(input.payload) && byteIdentical(entry, input.payload),
  );
  if (chain.length === 0) {
    return { chainKind: "new-info", e: 1, repeatCount: 1, delivery: "full" };
  }
  const e = chain.length + 1;
  // 指向链上最老条目：它是首次全文交付的那次，指针不会落在 stub 上。
  const pointedTo = chain[0]!;
  const sameArgsCount = chain.filter((entry) => entry.argsKey === argsKey).length;
  if (sameArgsCount > 0) {
    const repeatCount = sameArgsCount + 1;
    if (e >= 4) {
      return { chainKind: "param-loop", e, repeatCount, delivery: "stub", finalizeText: paramLoopFinalizeText(repeatCount) };
    }
    if (e === 3) {
      return {
        chainKind: "param-loop",
        e,
        repeatCount,
        delivery: "stub",
        stubText: resultStubText({ pointedTo, resultLoop: false, hasImages: input.payload.images.length > 0 }),
        warningText: repeatWarningText(repeatCount),
      };
    }
    if (payloadChars(input.payload) >= STUB_MIN_PAYLOAD) {
      return {
        chainKind: "param-loop",
        e,
        repeatCount,
        delivery: "stub",
        stubText: resultStubText({ pointedTo, resultLoop: false, hasImages: input.payload.images.length > 0 }),
      };
    }
    return { chainKind: "param-loop", e, repeatCount, delivery: "full" };
  }
  if (payloadChars(input.payload) >= STUB_MIN_PAYLOAD) {
    if (e >= 3) {
      return { chainKind: "result-loop", e, repeatCount: 1, delivery: "stub", finalizeText: RESULT_LOOP_FINALIZE_TEXT };
    }
    return {
      chainKind: "result-loop",
      e,
      repeatCount: 1,
      delivery: "stub",
      stubText: resultStubText({ pointedTo, resultLoop: true, hasImages: input.payload.images.length > 0 }),
    };
  }
  return { chainKind: "new-info", e, repeatCount: 1, delivery: "full" };
}

/** 窗口滑动：FIFO 追加，超过容量滑出最老条目（遗忘 → 链重计）。返回新数组（纯）。 */
export function pushFingerprintEntry(
  window: ReadonlyArray<FingerprintEntry>,
  entry: FingerprintEntry,
): FingerprintEntry[] {
  const next = [...window, entry];
  return next.length > FINGERPRINT_WINDOW_SIZE ? next.slice(next.length - FINGERPRINT_WINDOW_SIZE) : next;
}

/** 由一次已执行调用构造窗口条目（宿主在判定交付形态后调用）。 */
export function makeFingerprintEntry(input: {
  callId: string;
  toolName: string;
  params: unknown;
  payload: ToolPayload;
}): FingerprintEntry {
  const argsKey = argsKeyOf(input.params);
  return {
    callId: input.callId,
    toolName: input.toolName,
    argsKey,
    argsPreview: argsPreviewOf(argsKey),
    resultHash: hashPayload(input.payload),
    payloadText: input.payload.text,
    imageRefs: [...input.payload.images],
  };
}
