"""Loopback-only upload page for the independent AI service."""

from __future__ import annotations

import csv
import json
import os
import re
import tempfile
from argparse import Namespace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ai_service import CATEGORY_PATH, WEB_MODELS, classify, ensure_local_model, installed_local_models, pull_local_model
from categories import category_label, load_categories

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAPPING = Path(os.environ.get("AI_SERVICE_MAPPING_PATH", str(ROOT / "vendor_mapping.json")))
CATEGORIES = CATEGORY_PATH
MODEL = os.environ.get("AI_SERVICE_MODEL", "qwen2.5:3b")
ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8"),
          "/model.css": ("model.css", "text/css; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8")}


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status: HTTPStatus, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status: HTTPStatus, value: dict) -> None:
        self.send_bytes(status, json.dumps(value).encode(), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in ASSETS:
            filename, content_type = ASSETS[path]
            self.send_bytes(HTTPStatus.OK, (ROOT / filename).read_bytes(), content_type)
        elif path == "/api/status":
            try:
                installed = installed_local_models()
                available = True
            except (RuntimeError, ValueError):
                installed = set()
                available = False
            categories = load_categories(CATEGORIES)
            by_id = {item["id"]: item for item in categories}
            self.send_json(HTTPStatus.OK, {"ollama_ready": available, "default_model": MODEL,
                                            "category_count": len(categories),
                                            "categories": [{"id": item["id"], "kind": item["kind"],
                                                            "label": category_label(item, by_id)} for item in categories],
                                            "models": ([{"name": name, "size": size, "installed": name in installed,
                                                         "downloadable": True} for name, size in WEB_MODELS.items()]
                                                       + [{"name": name, "size": "", "installed": True,
                                                           "downloadable": False} for name in sorted(installed - WEB_MODELS.keys())
                                                          if not name.endswith(":cloud")])})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path not in {"/api/classify", "/api/pull-model"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        origin = self.headers.get("Origin")
        if origin and origin != f"http://127.0.0.1:{self.server.server_port}":
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "This page accepts local requests only"})
            return
        try:
            params = parse_qs(parsed.query)
            model = params.get("model", [MODEL])[0]
            if len(model) > 100 or not re.fullmatch(r"[A-Za-z0-9_./:-]+", model) or model.endswith(":cloud"):
                raise ValueError("Choose a local Ollama model")
            if parsed.path == "/api/pull-model":
                if model not in WEB_MODELS:
                    raise ValueError("Only the listed Qwen sizes can be downloaded from this page")
                pull_local_model(model)
                self.send_json(HTTPStatus.OK, {"installed": model})
                return
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_UPLOAD_BYTES:
                raise ValueError("Upload must be between 1 byte and 10 MB")
            filename = params.get("filename", [""])[0]
            suffix = Path(filename).suffix.lower()
            if suffix not in {".csv", ".xlsx"}:
                raise ValueError("Choose a .csv or .xlsx file")
            backend = params.get("backend", ["ollama"])[0]
            if backend not in {"ollama", "mock"}:
                raise ValueError("Invalid backend")
            limit_raw = params.get("limit", [""])[0]
            limit = int(limit_raw) if limit_raw else None
            if limit is not None and not 1 <= limit <= 2000:
                raise ValueError("Row limit must be between 1 and 2000")
            self_name = params.get("self_name", [""])[0].strip()
            if len(self_name) > 100:
                raise ValueError("Self name is too long")
            if backend == "ollama":
                ensure_local_model(model)
            body = self.rfile.read(length)
            with tempfile.TemporaryDirectory(prefix="ai-service-upload-") as temporary:
                work = Path(temporary)
                source = work / f"upload{suffix}"
                source.write_bytes(body)
                output = work / "output"
                args = Namespace(input=str(source), output_dir=str(output), mapping=str(MAPPING),
                                 categories=str(CATEGORIES),
                                 backend=backend, model=model, limit=limit,
                                 self_name=[self_name] if self_name else [])
                classify(args)
                with (output / "classified.csv").open(newline="", encoding="utf-8") as file:
                    classified = list(csv.DictReader(file))
                with (output / "review.csv").open(newline="", encoding="utf-8") as file:
                    review = list(csv.DictReader(file))
                self.send_json(HTTPStatus.OK, {
                    "backend": backend,
                    "model": model if backend == "ollama" else "mock",
                    "classified": classified,
                    "review": review,
                    "report": (output / "report.txt").read_text(encoding="utf-8"),
                    "classified_csv": (output / "classified.csv").read_text(encoding="utf-8"),
                    "review_csv": (output / "review.csv").read_text(encoding="utf-8"),
                })
        except (ValueError, RuntimeError, UnicodeError, OSError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Run the local AI service upload page")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", choices=["127.0.0.1", "0.0.0.0"], default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"AI service page: http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
