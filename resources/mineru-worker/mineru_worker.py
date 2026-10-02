"""PDFMuse MinerU JSON-lines worker.

The Windows package supplies a pinned Python runtime with MinerU (basic tier,
ONNX small models) and its model assets under MINERU_HOME. stdout is
protocol-only.
"""

import json
import os
import sys
from contextlib import redirect_stdout


def write_response(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

# docvortex 0.4.12 的 TextSpan 校验对同一 span 同时声明上下标直接抛 ValueError——
# 原生 PDF 的数学页（x_i^2 型公式行）样式区间物化时会合出这种组合，整页解析报废。
# 按 mineru 自家 legacy 适配器（legacy_schema_adapter._normalize_styles）的消解方式
# 丢弃 subscript；块协议只取 type/text/bbox，样式无损。幂等：原文在才打，
# 已打过或上游已改都跳过；补丁失败只记 stderr，不影响其余页解析。
DOCVORTEX_SCRIPT_CONFLICT_ORIGINAL = (
    '        unique = set(value)\n'
    '        if "superscript" in unique and "subscript" in unique:\n'
    '            raise ValueError("text span cannot be both superscript and subscript")\n'
    '        return [style for style in INLINE_STYLE_ORDER if style in unique]'
)
DOCVORTEX_SCRIPT_CONFLICT_PATCHED = (
    '        unique = set(value)\n'
    '        if "superscript" in unique:\n'
    '            unique.discard("subscript")\n'
    '        return [style for style in INLINE_STYLE_ORDER if style in unique]'
)


def patch_docvortex_script_conflict(package_dir=None):
    """修补钉版 runtime 里 docvortex 的上下标冲突校验；package_dir 仅供测试注入。"""
    try:
        if package_dir is None:
            import importlib.util
            spec = importlib.util.find_spec("docvortex")
            if spec is None or not spec.submodule_search_locations:
                print("[PDFMuse] 未找到 docvortex 包，跳过上下标冲突补丁。", file=sys.stderr)
                return
            package_dir = next(iter(spec.submodule_search_locations))
        schema_path = os.path.join(str(package_dir), "schema.py")
        with open(schema_path, encoding="utf-8") as handle:
            source = handle.read()
        if DOCVORTEX_SCRIPT_CONFLICT_ORIGINAL not in source:
            state = "已就绪" if DOCVORTEX_SCRIPT_CONFLICT_PATCHED in source else "与已知模式均不匹配（上游可能已改）"
            print(f"[PDFMuse] docvortex 上下标冲突补丁{state}，跳过。", file=sys.stderr)
            return
        # 读侧通用换行归一（CRLF/LF 都能命中 LF 模式）；写侧固定 LF，避免文本模式把全文翻成 CRLF。
        with open(schema_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(source.replace(DOCVORTEX_SCRIPT_CONFLICT_ORIGINAL, DOCVORTEX_SCRIPT_CONFLICT_PATCHED))
        print("[PDFMuse] 已修补 docvortex 上下标冲突校验（丢弃 subscript）。", file=sys.stderr)
    except Exception as exc:
        print(f"[PDFMuse] docvortex 补丁未应用（不影响其余页解析）：{exc}", file=sys.stderr)


def extract_blocks(result):
    """把单页解析结果转成 PDFMuse 块级协议：[{type, text, bbox}]，bbox 为 0-1 归一化浮点。

    结构化内容的形状为 pages[].blocks[]，每块 {type, bbox, content}：
    content 在文本/标题块是纯文本，在公式块是不带定界符的 LaTeX。
    image_analysis=False 时插图块只剩占位、无 image_source 兜底图，正合产品所需。
    """
    content = result.structured_content()
    pages = content.get("pages", []) if isinstance(content, dict) else []
    blocks = []
    for page in pages:
        page_blocks = page.get("blocks", []) if isinstance(page, dict) else []
        for item in page_blocks:
            if not isinstance(item, dict):
                continue
            bbox = item.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            try:
                box = [float(value) for value in bbox]
            except (TypeError, ValueError):
                continue
            blocks.append({
                "type": str(item.get("type", "text")),
                "text": str(item.get("content") or ""),
                "bbox": box,
            })
    return blocks


def main():
    # 先补后导：docvortex 的校验在 import 时随模型类固化，补丁必须落在导入之前。
    patch_docvortex_script_conflict()
    try:
        with redirect_stdout(sys.stderr):
            # image_analysis=False：插图不裁剪不编码（Reader 明确不需要图片内容）。
            from mineru.parser.mineru_parser import MinerUParser
            parser = MinerUParser(tier="basic", parse_mode="auto", image_analysis=False)
    except Exception as exc:
        write_response({"id": "", "ok": False, "message": f"MinerU 运行时未正确安装：{exc}"})
        return 1

    for raw in sys.stdin:
        request = {}
        try:
            request = json.loads(raw)
            pdf_path = str(request["pdfPath"])
            page = int(request["page"])
            want_markdown = bool(request.get("markdown", False))
            if page <= 0:
                raise ValueError("页码必须为正整数。")
            with redirect_stdout(sys.stderr):
                result = parser.parse(pdf_path, page_range=str(page))
                # markdown 含插图 base64，渲染成本高；仅对比脚本等显式请求时才计算。
                markdown = result.markdown() if want_markdown else ""
            write_response({"id": request.get("id", ""), "ok": True, "result": {
                "blocks": extract_blocks(result),
                "markdown": markdown,
            }})
        except Exception as exc:
            write_response({"id": request.get("id", ""), "ok": False, "message": f"MinerU 解析失败：{exc}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
