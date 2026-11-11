import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const source=ts.transpileModule(fs.readFileSync('app/lib/sap-stock-query.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText;
const {sapStockBalanceQuery}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
for(const date of ['', '2026-02-29', '2026-11-31', '2026-13-01', '0000-01-01', "2026-11-03'); DELETE FROM OINM;--"])
  assert.equal(sapStockBalanceQuery(date),'','Invalid or interpolated SQL dates must not be copyable');
assert.ok(sapStockBalanceQuery('2028-02-29'),'A valid leap day must work');

// Execute the generated SELECT with real aggregation over fixtures. SQLite is a
// semantic test, not a HANA server; only TO_DATE needs a compatible date shim.
const result=spawnSync('python3',['-c',`
import datetime, json, sqlite3, sys
queries = json.load(sys.stdin)
db = sqlite3.connect(':memory:')
def to_date(value, fmt):
    assert fmt == 'YYYY-MM-DD'
    return datetime.date.fromisoformat(value).isoformat()
db.create_function('TO_DATE', 2, to_date)
db.executescript('''
CREATE TABLE OITM (ItemCode TEXT PRIMARY KEY, ItemName TEXT, InvntryUom TEXT);
CREATE TABLE OINM (ItemCode TEXT, Warehouse TEXT, DocDate TEXT, InQty NUMERIC, OutQty NUMERIC, TransType TEXT);
INSERT INTO OITM VALUES ('A','جزر','Piece'),('B','رصيد صفري','Piece'),('C','بلا حركة هذا الشهر','KG'),('D','رصيد سالب','KG'),('F','حركة لاحقة فقط','Piece');
INSERT INTO OINM VALUES
 ('A','011','2026-10-10',20,0,'Opening'),
 ('A','011','2026-11-01',100,0,'67'),
 ('A','011','2026-11-02',0,30,'15'),
 ('A','011','2026-11-03',7,0,'59'),
 ('A','011','2026-11-03',0,2,'60'),
 ('A','011','2026-11-03',5,0,'Adjustment'),
 ('A','011','2026-11-04',0,1000,'67'),
 ('A','001','2026-11-03',8000,0,'67'),
 ('B','011','2026-10-01',8,0,'67'),
 ('B','011','2026-11-03',0,8,'Cancellation'),
 ('C','011','2025-01-01',2.5,0,'Opening'),
 ('D','011','2026-11-03',0,4,'60'),
 ('E','011','2026-11-03',3,0,'59'),
 ('F','011','2026-11-04',100,0,'67');
''')
results=[]
for query in queries:
    cursor=db.execute(query)
    results.append({'headers':[col[0] for col in cursor.description], 'rows':cursor.fetchall()})
print(json.dumps(results))
`],{input:JSON.stringify(['2026-10-31','2026-11-01','2026-11-03','2026-11-04'].map(sapStockBalanceQuery)),encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
const [opening,firstDay,closing,nextDay]=JSON.parse(result.stdout);
assert.deepEqual(closing.headers,['رقم الصنف','اسم الصنف','المستودع','وحدة المخزون','الرصيد الفعلي بنهاية التاريخ']);
assert.deepEqual(closing.rows.map(row=>[row[0],row[4]]),[['A',100],['B',0],['C',2.5],['D',-4],['E',3]],
  'Keep zero, negative and historical-only balances; include all document types and retain journal items missing a master record');
assert.ok(closing.rows.every(row=>row[2]==='011'),'Other warehouses must not affect balance');
assert.equal(closing.rows.find(row=>row[0]==='C')[3],'KG','Use inventory UoM without carton conversions');
assert.equal(opening.rows.find(row=>row[0]==='A')[4],20);
assert.equal(firstDay.rows.find(row=>row[0]==='A')[4],120,'Closing Nov 1 includes Nov 1 postings; it is not opening stock');
assert.equal(nextDay.rows.find(row=>row[0]==='A')[4],-900,'Changing the selected cutoff changes the executed balance');
assert.ok(nextDay.rows.some(row=>row[0]==='F'),'Future movements must appear only after their posting date');
console.log('PASS: SAP stock SQL aggregation fixtures, inclusive cutoff, all history/types, zero/negative stock, inventory UoM and date validation (SQLite semantic test).');
