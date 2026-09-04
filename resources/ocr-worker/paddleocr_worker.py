"""PDFMuse's vendored PaddleOCR stdio bridge.

The embeddable Python runtime and pinned PaddleOCR wheels are supplied by the
Windows installer.  stdout is reserved for one JSON response per request;
diagnostics belong on stderr so the Node worker protocol stays unambiguous.
"""
import base64
import json
import sys
import os


def main():
    try:
        import numpy as np
        from PIL import Image
        from paddleocr import PaddleOCR
    except Exception as exc:
        print(json.dumps({"id": "", "ok": False, "message": f"OCR 运行时未正确安装：{exc}"}, ensure_ascii=False), flush=True)
        return 1

    model_root = os.environ.get("PDFMUSE_OCR_MODEL_DIR")
    options = {
        "lang": "ch",
        "ocr_version": "PP-OCRv5",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": True,
    }
    if model_root:
        options.update({
            "text_detection_model_dir": os.path.join(model_root, "det"),
            "text_recognition_model_dir": os.path.join(model_root, "rec"),
        })
    ocr = PaddleOCR(
        **options,
    )
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            image = Image.open(__import__("io").BytesIO(base64.b64decode(request["imageData"]))).convert("RGB")
            array = np.asarray(image)
            result = next(iter(ocr.predict(array)))
            data = result.json if callable(getattr(result, "json", None)) else getattr(result, "json", result)
            if isinstance(data, str):
                data = json.loads(data)
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            polygons = data.get("rec_polys", data.get("dt_polys", []))
            lines = []
            for index, text in enumerate(texts):
                polygon = polygons[index].tolist() if index < len(polygons) and hasattr(polygons[index], "tolist") else polygons[index] if index < len(polygons) else []
                if not isinstance(polygon, list) or len(polygon) < 4:
                    continue
                points = [{"x": float(point[0]), "y": float(point[1])} for point in polygon[:4]]
                score = float(scores[index]) if index < len(scores) else 0.0
                lines.append({"text": str(text), "confidence": max(0.0, min(1.0, score)), "polygon": points})
            response = {"id": request.get("id", ""), "ok": True, "result": {
                "width": int(array.shape[1]), "height": int(array.shape[0]), "orientation": 0, "lines": lines,
            }}
        except Exception as exc:
            response = {"id": request.get("id", ""), "ok": False, "message": f"OCR 识别失败：{exc}"}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
