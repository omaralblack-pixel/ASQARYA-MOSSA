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

# Exercise the actual production projection against SQLite, including incomplete
# and malformed legacy records. The read must retain approval/link semantics
# while keeping reviewed SAP quantities and leaving stored payloads untouched.
import re
source=Path('app/api/reconcile/route.ts').read_text()
projection=re.search(r"db\(\)\.prepare\(`(SELECT id,branch,status,CASE WHEN json_valid\(payload\).*?)`\)\.all\(\)",source,re.S).group(1)
fixture={'transfers':[{'number':'2617000','paste':'reviewed SAP quantities'},{'number':'2617001 + 2617002'}],
 'invoices':[{'number':'2623014032','complete':True,'amount':'1.000'},{'number':'2623014033','complete':False}],
 'referenceSnapshot':[{'name':'large reference data'*5000}]}
saved=json.dumps(fixture)
c.execute("INSERT INTO reconciliations VALUES ('projection','200','branch','','2026-11-04',?,'match','now','now',1,'revision')",(saved,))
c.execute("INSERT INTO reconciliations VALUES ('broken','201','branch','','2026-11-04','not-json','review','now','now',1,'revision')")
c.execute("INSERT INTO reconciliations VALUES ('wrong-shape','202','branch','','2026-11-04',?,'review','now','now',1,'revision')",(json.dumps({'transfers':'bad','invoices':[]}),))
rows={row[0]:row[3] for row in c.execute(projection)}
compact=json.loads(rows['projection'])
assert compact['transfers']==[{'number':'2617000','paste':'reviewed SAP quantities'},{'number':'2617001 + 2617002','paste':None}]
assert compact['invoices']==[{'number':'2623014032','complete':True},{'number':'2623014033','complete':False}]
assert rows['broken']=='not-json'
assert json.loads(rows['wrong-shape'])['transfers']=='bad'
assert len(rows['projection'])<len(saved)/100
assert c.execute("SELECT payload FROM reconciliations WHERE id='projection'").fetchone()[0]==saved
print('PASS: lieutenant read projection preserves links, true/false approval flags and malformed records, reduces response size, and never modifies stored invoices')
