import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("prepare-d1-backup.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class D1ExportTest(unittest.TestCase):
    def test_invoice_and_decision_rows_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = sqlite3.connect(":memory:")
            db.execute("CREATE TABLE reconciliations(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            db.execute("CREATE TABLE colonel_days(day TEXT PRIMARY KEY,invoices_complete INTEGER)")
            db.execute("INSERT INTO reconciliations VALUES (?,?)",
                       ("g1", '{"date":"2026-11-01","branch":"الكرامة","amount":"526.320"}'))
            db.execute("INSERT INTO colonel_days VALUES ('2026-11-01',1)")
            db.commit()
            source = root / "source.sql"
            source.write_text("\n".join(db.iterdump()), encoding="utf-8")
            db.close()
            manifest = module.export(source, root / "out")
            records = [json.loads(line) for line in (root / "out" / "rows.jsonl")
                       .read_text(encoding="utf-8").splitlines()]
            self.assertEqual(manifest["total_rows"], 2)
            self.assertEqual(manifest["tables"]["reconciliations"]["rows"], 1)
            self.assertIn("526.320", records[1]["row_json"]["payload"])
            self.assertEqual(records[0]["row_json"]["invoices_complete"], 1)
            with self.assertRaises(RuntimeError):
                module.export(source, root / "out")


if __name__ == "__main__":
    unittest.main()
