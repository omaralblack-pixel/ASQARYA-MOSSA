#!/usr/bin/env python3
"""Prepare a read-only D1 SQL export for audited migration to PostgreSQL.

Usage: python prepare-d1-backup.py SOURCE.sql --output-dir BACKUP_DIR

The generated manifest and JSONL contain potentially confidential invoices and
security-table data. Keep them local; never commit them to version control.
"""
import argparse
import base64
import hashlib
import json
import sqlite3
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def encode(value):
    if isinstance(value, bytes):
        return {"$d1_blob_base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    raise TypeError(f"Unsupported SQLite value: {type(value)}")


def ident(name):
    return '"' + name.replace('"', '""') + '"'


def export(source: Path, output: Path):
    sql_bytes = source.read_bytes()
    dump_hash = digest(sql_bytes)
    if output.exists() and any(output.iterdir()):
        raise RuntimeError(f"Output directory must be empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    try:
        db.executescript(sql_bytes.decode("utf-8-sig"))
        tables = sorted(row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ))
        manifest = {"format": "asqarya-d1-audit-v1", "source_file": source.name,
                    "source_sha256": dump_hash, "tables": {}, "total_rows": 0}
        with (output / "rows.jsonl").open("x", encoding="utf-8") as fh:
            for table in tables:
                columns = [tuple(c) for c in db.execute(f"PRAGMA table_info({ident(table)})")]
                pk = [c[1] for c in sorted(columns, key=lambda c: c[5]) if c[5] > 0]
                if pk:
                    cursor = db.execute(f"SELECT * FROM {ident(table)}")
                else:
                    cursor = db.execute(f"SELECT rowid AS __source_rowid__, * FROM {ident(table)}")
                entries = []
                for row in cursor:
                    values = {k: encode(row[k]) for k in row.keys() if k != "__source_rowid__"}
                    key_values = {k: values[k] for k in pk} if pk else {"rowid": row["__source_rowid__"]}
                    key = canonical(key_values)
                    payload = canonical(values)
                    entries.append((key, {"table_name": table, "row_key": key, "row_json": values,
                                          "row_sha256": digest(payload.encode("utf-8"))}))
                entries.sort(key=lambda entry: entry[0])
                if len(entries) != len(set(entry[0] for entry in entries)):
                    raise ValueError(f"Duplicate primary keys in table {table}")
                table_hasher = hashlib.sha256()
                for _, obj in entries:
                    serial = canonical(obj)
                    fh.write(serial + "\n")
                    table_hasher.update((serial + "\n").encode("utf-8"))
                manifest["tables"][table] = {"rows": len(entries), "primary_key": pk,
                                                "sha256": table_hasher.hexdigest()}
                manifest["total_rows"] += len(entries)
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return manifest
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Cloudflare D1 --remote SQL export")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    result = export(args.source, args.output_dir)
    print(f"Audited {len(result['tables'])} tables, {result['total_rows']} rows; SHA-256 {result['source_sha256']}")
    print("Private files created: manifest.json, rows.jsonl (do not commit or publish)")


if __name__ == "__main__":
    main()
