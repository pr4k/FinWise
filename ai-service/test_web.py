import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from ai_service import read_rows
from web_server import Handler, classify as web_classify


def sample_xlsx(path: Path) -> None:
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    office_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    workbook = f'<workbook xmlns="{main}" xmlns:r="{office_rel}"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>'
    rels = f'<Relationships xmlns="{package_rel}"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="{office_rel}/worksheet"/></Relationships>'
    sheet = f'''<worksheet xmlns="{main}"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Description</t></is></c><c r="B1" t="inlineStr"><is><t>Debit</t></is></c><c r="C1" t="inlineStr"><is><t>Credit</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>UPI/CHEQ DIGIT/cheq@upi/Sent using/AXIS BANK</t></is></c><c r="B2"><v>100</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>UPI/ANITA SHARMA/anita@upi/Sent using/AXIS BANK</t></is></c><c r="C3"><v>50</v></c></row>
      </sheetData></worksheet>'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


class WebTests(unittest.TestCase):
    def test_xlsx_read_and_local_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workbook = root / "statement.xlsx"
            sample_xlsx(workbook)
            fields, rows = read_rows(workbook, None)
            self.assertEqual(fields, ["Description", "Debit", "Credit"])
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["Debit"], "100")
            (root / "categories.json").write_text(json.dumps({"version": 1, "categories": [
                {"id": "settlement", "name": "Credit card settlement", "kind": "expense", "parent_id": None}]}))
            category_patch = patch("web_server.CATEGORIES", root / "categories.json")
            category_patch.start()
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch("web_server.MODEL", "qwen2.5:1.5b"), patch("web_server.installed_local_models", return_value={"qwen2.5:1.5b", "llama3.2", "other:cloud"}):
                    with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/api/status") as response:
                        status = json.load(response)
                self.assertEqual(status["default_model"], "qwen2.5:1.5b")
                self.assertEqual(status["category_count"], 1)
                self.assertEqual(status["categories"][0]["id"], "settlement")
                self.assertTrue(next(model for model in status["models"] if model["name"] == "qwen2.5:1.5b")["installed"])
                self.assertTrue(next(model for model in status["models"] if model["name"] == "llama3.2")["installed"])
                self.assertFalse(any(model["name"] == "other:cloud" for model in status["models"]))
                pull = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/api/pull-model?model=qwen2.5%3A0.5b", data=b"", method="POST")
                with patch("web_server.pull_local_model") as pull_model:
                    with urllib.request.urlopen(pull) as response:
                        self.assertEqual(json.load(response)["installed"], "qwen2.5:0.5b")
                pull_model.assert_called_once_with("qwen2.5:0.5b")
                invalid = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/api/pull-model?model=other%3Acloud", data=b"", method="POST")
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(invalid)
                self.assertEqual(error.exception.code, 400)
                error.exception.close()
                url = f"http://127.0.0.1:{server.server_port}/api/classify?filename=statement.xlsx&backend=mock&model=qwen2.5%3A1.5b"
                request = urllib.request.Request(url, data=workbook.read_bytes(), method="POST")
                chosen = []
                def capture(args):
                    chosen.append(args.model)
                    return web_classify(args)
                with patch("web_server.MAPPING", root / "mapping.json"), patch("web_server.classify", side_effect=capture):
                    with urllib.request.urlopen(request) as response:
                        payload = json.load(response)
                self.assertEqual(chosen, ["qwen2.5:1.5b"])
                self.assertEqual(len(payload["classified"]), 2)
                self.assertEqual(payload["classified"][0]["vendor_type"], "payment_service")
                self.assertEqual(payload["classified"][0]["category_id"], "settlement")
                self.assertEqual(payload["classified"][1]["vendor_type"], "unknown")
                self.assertEqual(len(payload["review"]), 1)
                self.assertNotIn("ANITA SHARMA", payload["report"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                category_patch.stop()


if __name__ == "__main__":
    unittest.main()
