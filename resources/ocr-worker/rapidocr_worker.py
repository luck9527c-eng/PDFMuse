"""PDFMuse RapidOCR JSON-lines worker.

The Windows package supplies a pinned Python runtime with RapidOCR,
ONNX Runtime, and the bundled PP-OCR models. stdout is protocol-only.
"""

import base64
from contextlib import redirect_stdout
import json
import sys


def write_response(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    try:
        with redirect_stdout(sys.stderr):
            from rapidocr import RapidOCR
            engine = RapidOCR(params={
                "Global.log_level": "error",
                "EngineConfig.onnxruntime.intra_op_num_threads": 4,
                "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            })
    except Exception as exc:
        write_response({"id": "", "ok": False, "message": f"OCR 运行时未正确安装：{exc}"})
        return 1

    for raw in sys.stdin:
        request = {}
        try:
            request = json.loads(raw)
            image = base64.b64decode(request["imageData"], validate=True)
            with redirect_stdout(sys.stderr):
                result = engine(image)
            boxes = result.boxes if result.boxes is not None else []
            texts = result.txts if result.txts is not None else []
            scores = result.scores if result.scores is not None else []
            lines = []
            for index, text in enumerate(texts):
                if index >= len(boxes):
                    continue
                polygon = boxes[index].tolist() if hasattr(boxes[index], "tolist") else boxes[index]
                if not isinstance(polygon, list) or len(polygon) < 4:
                    continue
                points = [{"x": float(point[0]), "y": float(point[1])} for point in polygon[:4]]
                score = float(scores[index]) if index < len(scores) else 0.0
                lines.append({
                    "text": str(text),
                    "confidence": max(0.0, min(1.0, score)),
                    "polygon": points,
                })
            write_response({"id": request.get("id", ""), "ok": True, "result": {
                "width": int(request["width"]),
                "height": int(request["height"]),
                "orientation": 0,
                "lines": lines,
            }})
        except Exception as exc:
            write_response({"id": request.get("id", ""), "ok": False, "message": f"OCR 识别失败：{exc}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
