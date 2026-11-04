import sqlite3,json
from pathlib import Path
sql=json.loads(Path('app/lib/reconciliation-schema.json').read_text())
c=sqlite3.connect(':memory:')
c.execute('CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL)')
c.execute("INSERT INTO settings VALUES ('sapLinks','preserved')")
for _ in range(2):
 for statement in sql:c.execute(statement)
assert c.execute("SELECT value FROM settings WHERE key='sapLinks'").fetchone()[0]=='preserved'
c.execute("INSERT INTO reconciliations VALUES ('g','100','branch','','2026-11-04','{}','review','now','now',1,'revision')")
c.execute("INSERT INTO transfer_keys VALUES ('100','g')")
try:
 c.execute("INSERT INTO transfer_keys VALUES ('100','other')")
 raise AssertionError('duplicate transfer accepted')
except sqlite3.IntegrityError:pass
for statement in sql:c.execute(statement)
assert c.execute('SELECT count(*) FROM reconciliations').fetchone()[0]==1
assert c.execute('SELECT group_id FROM transfer_keys').fetchone()[0]=='g'
print('PASS: standalone Cloudflare schema initializes idempotently, preserves settings and saved groups, and enforces unique transfer keys')
