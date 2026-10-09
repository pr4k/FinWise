import csv
import json
import tempfile
import unittest
from unittest.mock import patch
from argparse import Namespace
from pathlib import Path

from ai_service import apply_review, category_proposal, classify, ensure_local_model, extract, mock_proposal, ollama_url, validate_proposal
from categories import load_categories, sync_categories


class ClassifierTests(unittest.TestCase):
    def test_extraction_and_conservative_unknown(self):
        self.assertEqual(extract("UPI/CHEQ DIGIT/cheq4.payu@axi/Sent using/AXIS BANK")[0], "CHEQ DIGIT")
        self.assertEqual(mock_proposal("UPI/ANITA SHARMA/anita@upi/Sent using/AXIS BANK")["vendor_type"], "unknown")
        with self.assertRaises(ValueError):
            validate_proposal({"vendor_type": "retailer", "transaction_type": "purchase", "evidence": "shop", "confidence": .9}, "UPI/ANITA SHARMA/anita@upi")
        with self.assertRaises(ValueError):
            ensure_local_model("some-model:cloud")
        with patch.dict("os.environ", {"AI_SERVICE_OLLAMA_URL": "http://127.0.0.1:11435"}):
            self.assertEqual(ollama_url("/api/tags"), "http://127.0.0.1:11435/api/tags")
        with patch.dict("os.environ", {"AI_SERVICE_OLLAMA_URL": "https://example.com"}):
            with self.assertRaises(ValueError):
                ollama_url("/api/tags")

    def test_pipeline_review_mapping_and_self_transfer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.csv"
            rows = [
                ["UPI/CHEQ DIGIT/cheq@upi/Sent using/AXIS BANK", "100", ""],
                ["UPI/PRIYA SINGH/priya@upi/Sent using/AXIS BANK", "50", ""],
                ["UPI/OWNER NAME/owner@upi/NA/AXIS BANK", "", "20"],
                ["EBA/EQ Trade 01APR/20260401164422", "200", ""],
            ]
            with source.open("w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["Description", "Debit", "Credit"])
                writer.writerows(rows)
            original = source.read_bytes()
            categories_path = root / "categories.json"
            categories_path.write_text(json.dumps({"version": 1, "categories": [
                {"id": "groceries", "name": "Groceries", "kind": "expense", "parent_id": None}]}))
            args = Namespace(input=str(source), output_dir=str(root / "out"), mapping=str(root / "mapping.json"), categories=str(categories_path), backend="mock", model="unused", limit=None, self_name=["OWNER NAME"])
            classify(args)
            self.assertEqual(source.read_bytes(), original)
            with (root / "out" / "classified.csv").open() as f:
                results = list(csv.DictReader(f))
            self.assertEqual(results[0]["vendor_type"], "payment_service")
            self.assertEqual(results[1]["vendor_type"], "unknown")
            self.assertEqual(results[2]["transaction_type"], "self_transfer")
            self.assertEqual(results[3]["transaction_type"], "investment")
            self.assertEqual(results[3]["vendor_type"], "unknown")
            with (root / "out" / "review.csv").open() as f:
                review = list(csv.DictReader(f))
            target = next(item for item in review if item["counterparty"] == "PRIYA SINGH")
            target["decision"] = "correct"
            target["approved_vendor_type"] = "retailer"
            target["approved_transaction_type"] = "purchase"
            target["approved_category_id"] = "groceries"
            with (root / "out" / "review.csv").open("w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=review[0])
                writer.writeheader()
                writer.writerows(review)
            apply_review(Namespace(review=str(root / "out" / "review.csv"), mapping=str(root / "mapping.json"), categories=args.categories))
            self.assertEqual(json.loads((root / "mapping.json").read_text())["PRIYA SINGH"]["vendor_type"], "retailer")
            self.assertEqual(json.loads((root / "mapping.json").read_text())["PRIYA SINGH"]["category_id"], "groceries")
            classify(args)
            with (root / "out" / "classified.csv").open() as f:
                results = list(csv.DictReader(f))
            self.assertEqual(results[1]["vendor_type"], "retailer")
            self.assertEqual(results[1]["transaction_type"], "purchase")
            self.assertEqual(results[1]["source"], "review")
            self.assertEqual(results[1]["category_id"], "groceries")

    def test_local_category_snapshot_and_classification(self):
        import sqlite3
        from contextlib import closing
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db_path = root / "finwise.sqlite"
            with closing(sqlite3.connect(db_path)) as db:
                db.execute("CREATE TABLE resources (id TEXT, household_id TEXT, kind TEXT, document TEXT)")
                records = [
                    ("settlement", "Credit card settlement", "expense", None, False),
                    ("investment", "Investment", "expense", None, False),
                    ("salary", "💰 Salary", "income", None, False),
                    ("archived", "Old", "expense", None, True),
                ]
                for id_, name, kind, parent_id, archived in records:
                    db.execute("INSERT INTO resources VALUES (?,?,?,?)", (id_, "household", "categories",
                               json.dumps({"name": name, "kind": kind, "parent_id": parent_id, "archived": archived})))
                db.commit()
            snapshot = root / "categories.json"
            self.assertEqual(sync_categories(db_path, snapshot), 3)
            self.assertEqual({item["id"] for item in load_categories(snapshot)}, {"settlement", "investment", "salary"})
            source = root / "statement.csv"
            with source.open("w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["Description", "Debit", "Credit"])
                writer.writerows([
                    ["UPI/CHEQ DIGIT/cheq@upi/CC BILL", "100", ""],
                    ["EBA/EQ Trade 01APR/12345", "200", ""],
                    ["SALARY OCTOBER", "", "300"],
                    ["UPI/OWNER NAME/owner@upi", "", "50"],
                ])
            args = Namespace(input=str(source), output_dir=str(root / "out"), mapping=str(root / "mapping.json"),
                             categories=str(snapshot), backend="mock", model="unused", limit=None,
                             self_name=["OWNER NAME"])
            classify(args)
            with (root / "out" / "classified.csv").open() as f:
                rows = list(csv.DictReader(f))
            self.assertEqual([row["category_id"] for row in rows], ["settlement", "investment", "salary", "unknown"])
            self.assertEqual(rows[0]["category"], "Credit card settlement")
            self.assertEqual(rows[3]["transaction_type"], "self_transfer")
            with (root / "out" / "review.csv").open() as f:
                review = list(csv.DictReader(f))
            self.assertIn("approved_category_id", review[0])

    def test_category_model_requires_literal_safe_evidence(self):
        import io
        categories = [{"id": "taxi", "name": "Taxi", "kind": "expense", "parent_id": None}]
        description = "UPI/UBER/uber@upi/taxi ride"
        response = json.dumps({"response": json.dumps({
            "category_id": "taxi", "evidence": description, "confidence": .91})}).encode()
        with patch("ai_service.urllib.request.urlopen", return_value=io.BytesIO(response)):
            result = category_proposal(description, "debit", "purchase", categories, "ollama", "test-model")
        self.assertEqual(result["category_id"], "taxi")
        self.assertEqual(result["evidence"], "taxi")


if __name__ == "__main__":
    unittest.main()
