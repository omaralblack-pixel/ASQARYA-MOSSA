import sqlite3, json
db=sqlite3.connect(':memory:')
db.execute('CREATE TABLE reconciliations(id text primary key, branch text, payload text)')
db.execute('CREATE TABLE invoice_keys(key text primary key, group_id text)')
original={'transfers':[{'number':'2615881+2615882'}],'invoices':[{'number':'2631202691'}]}
db.execute('INSERT INTO reconciliations VALUES (?,?,?)',('g1','25',json.dumps(original)))
db.execute('INSERT INTO invoice_keys VALUES (?,?)',('25|2631202691','g1'))
query="SELECT r.id,json_extract(i.value,'$.number') AS number FROM reconciliations r, json_each(r.payload,'$.invoices') i WHERE r.id<>?"
assert ('g1','2631202691') in db.execute(query,('g2',)).fetchall()
check="SELECT group_id FROM invoice_keys WHERE substr(key,instr(key,'|')+1)=? AND group_id<>? LIMIT 1"
assert db.execute(check,('2631202691','g2')).fetchone()==('g1',)
assert db.execute(check,('2631202692','g2')).fetchone() is None
assert db.execute(check,('2631202691','g1')).fetchone() is None
db.execute('INSERT INTO invoice_keys VALUES (?,?)',('GLOBAL|2631202692','g2'))
try:
 db.execute('INSERT INTO invoice_keys VALUES (?,?)',('GLOBAL|2631202692','g3'))
 raise AssertionError('global invoice lock must prevent simultaneous duplicates')
except sqlite3.IntegrityError: pass
print('PASS: duplicate invoice across branches, same-group edit, same branch new invoice, atomic lock')


# The lieutenant importer must examine document identifiers, not download every
# previously saved invoice payload for each SAP batch.
import pathlib
route=pathlib.Path('app/api/reconcile/route.ts').read_text(encoding='utf8')
import_fragment=route.split("if (b.action === 'lieutenantImport') {",1)[1].split("if (b.action === 'save')",1)[0]
assert "SELECT payload FROM reconciliations" not in import_fragment
assert "json_extract(t.value,'$.number') AS number" in import_fragment
assert "SELECT key FROM transfer_keys" in import_fragment
assert "SELECT transfer_no FROM lieutenant_queue" in import_fragment
assert "transferNumbers(row.number||'')" in import_fragment

db.execute('CREATE TABLE transfer_keys(key text primary key, group_id text)')
db.execute('CREATE TABLE lieutenant_queue(transfer_no text primary key)')
db.execute('INSERT INTO transfer_keys VALUES (?,?)', ('2616390','g1'))
db.execute('INSERT INTO lieutenant_queue VALUES (?)', ('2616392',))
db.execute('INSERT INTO reconciliations VALUES (?,?,?)', (
    'g2','19',json.dumps({'transfers':[{'number':'2616393 + 2616394'},{'number':'2,616,395'}],
                          'invoices':[{'number':'2630806229'}],
                          'auditLines':'x'*250000})))
db.execute('INSERT INTO reconciliations VALUES (?,?,?)', ('bad','19','{malformed'))
want=['2616390','2616392','2616393','2616394','2616395','2616396']
requested=json.dumps(want)
keys={row[0] for row in db.execute(
    'SELECT key FROM transfer_keys WHERE key IN (SELECT value FROM json_each(?))',(requested,))}
queued={row[0] for row in db.execute(
    'SELECT transfer_no FROM lieutenant_queue WHERE transfer_no IN (SELECT value FROM json_each(?))',(requested,))}
legacy_sql="""SELECT json_extract(t.value,'$.number') AS number
     FROM reconciliations r,
          json_each(CASE WHEN json_valid(r.payload) THEN r.payload ELSE '{}' END,'$.transfers') t
     WHERE t.type='object' AND json_type(t.value,'$.number')='text'"""
legacy_numbers=[row[0] for row in db.execute(legacy_sql).fetchall()]
assert '2616393 + 2616394' in legacy_numbers
assert '2,616,395' in legacy_numbers
assert all(len(item)<30 for item in legacy_numbers)
def normalize_doc_numbers(value):
    return [token.strip().replace(',','').replace('٬','')
            for token in value.replace('،','+').split('+') if token.strip()]
existing=keys|queued|{n for v in legacy_numbers for n in normalize_doc_numbers(v) if n in want}
assert existing=={'2616390','2616392','2616393','2616394','2616395'}
assert '2616396' not in existing
print('PASS: compact lieutenant import detects indexed, queued and multi-number legacy transfers without reading invoice blobs')
