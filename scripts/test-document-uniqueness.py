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
