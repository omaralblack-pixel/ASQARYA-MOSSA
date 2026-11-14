import json
import pathlib
import re
import sqlite3

source = pathlib.Path('app/api/reconcile/route.ts').read_text()
query = re.search(r"db\(\)\.prepare\(\x60(SELECT id,branch,driver,doc_date,status,created,updated,version,.*?)\x60\)", source).group(1)
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

# A single malformed legacy record must not make the whole records API fail.
bad = ['not-json', 'null', json.dumps({'invoices': [], 'transfers': ['not an object']}),
       json.dumps({'invoices': [None], 'transfers': []})]
for index, original in enumerate(bad):
    db.execute('INSERT INTO reconciliations VALUES (?,?,?,?,?,?,?,?,?)',
               (f'bad-{index}', 'branch', '', '2026-11-08', 'review', '', '', 1, original))
returned = {row[0]: row[-1] for row in db.execute(query)}
assert len(returned) == 1 + len(bad)
for index, original in enumerate(bad):
    assert returned[f'bad-{index}'] == original
    assert db.execute('SELECT payload FROM reconciliations WHERE id=?', (f'bad-{index}',)).fetchone()[0] == original
print('PASS: malformed and nested-invalid historical records remain visible without breaking the records API or modifying data')
