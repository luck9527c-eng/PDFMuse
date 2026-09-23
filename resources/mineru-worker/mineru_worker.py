"""PDFMuse MinerU JSON-lines worker.

The Windows package supplies a pinned Python runtime with MinerU (basic tier,
ONNX small models) and its model assets under MINERU_HOME. stdout is
protocol-only.
"""

import json
import sys
from contextlib import redirect_stdout


def write_response(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


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
