import json
import pathlib
import re
import sqlite3

source = pathlib.Path('app/api/reconcile/route.ts').read_text()
query = re.search(r"db\(\)\.prepare\(\x60(SELECT id,branch,driver,doc_date,status,created,updated,version,json_object.*?)\x60\)", source).group(1)
db = sqlite3.connect(':memory:')
db.execute('CREATE TABLE reconciliations (id, branch, driver, doc_date, status, created, updated, version, payload)')
payload = {'summary': {}, 'transfers': [{'number': '1001', 'date': '2026-11-08'}], 'invoices': [
    {'number': '123', 'date': '2026-11-07', 'amount': '10.000', 'complete': True},
    {'number': '124', 'date': '2026-11-08', 'amount': '5.000', 'complete': False}]}
db.execute('INSERT INTO reconciliations VALUES (?,?,?,?,?,?,?,?,?)', ('g','branch','','2026-11-08','match','','',1,json.dumps(payload)))
result = json.loads(db.execute(query).fetchone()[-1])
assert result['invoices'][0]['complete'] is True
assert result['invoices'][1]['complete'] is False
assert result['invoices'][0]['date'] == '2026-11-07'
assert result['transfers'][0]['number'] == '1001'
print('PASS: received and pending invoice states remain JSON booleans in records')
