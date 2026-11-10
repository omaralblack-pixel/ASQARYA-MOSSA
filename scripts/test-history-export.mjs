import fs from 'node:fs';import ts from 'typescript';import assert from 'node:assert/strict';
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const asUrl=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const reconcileUrl=asUrl(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const source=fs.readFileSync('app/lib/history-export.ts','utf8').replace("'./reconcile'","'"+reconcileUrl+"'");
const {historyExportRows}=await import(asUrl(compile(source)));
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const paste=(from,to)=>header+'\nCHS00033\tCheese\t2\tPiece\t'+from+'\t'+to;
const draft={transfers:[{number:'1001',paste:paste('001','011')},{number:'1002',paste:paste('011','001')},{number:'1003',paste:''}],invoices:[{number:'123',date:'2026-11-07',amount:'13.250',complete:true},{number:'124',date:'2026-11-08',amount:'',complete:false}]};
const rows=historyExportRows([{id:'1',branch:'2 — أسواق طارق',doc_date:'2026-11-08',payload:JSON.stringify(draft)}]);
assert.equal(rows.length,3);
assert.deepEqual(rows[1],['123','2 — أسواق طارق','2026-11-07','1001','1002','1003','واصلاني','13.250']);
assert.equal(rows[2][6],'غير مكتملة');assert.equal(rows[2][7],'');
console.log('PASS: history export preserves all invoices and transfer directions');

const importModule=asUrl(compile(fs.readFileSync('app/lib/sap-import.ts','utf8').replace("'./reconcile'","'"+reconcileUrl+"'")));
const stockSource=fs.readFileSync('app/lib/stock-report.ts','utf8')
  .replace("'./reconcile'","'"+reconcileUrl+"'")
  .replace("'./sap-import'","'"+importModule+"'");
const {stockReport}=await import(asUrl(compile(stockSource)));
const stockHeader='رقم الترحيل\tتاريخ الترحيل\tكود الفرع\tاسم الفرع\tRemarks\t'+header;
const stockLine=(no,quantity,from,to,unit='Piece')=>
  [no,'09.11.2026','1','Branch','','DAR00047','Orasi',quantity,unit,from,to].join('\t');
const movements=[
  stockLine('1',20,'009','011'),
  stockLine('2',5,'011','002'),
  stockLine('3',-3,'002','011'),
  stockLine('4',-2,'011','002'),
  stockLine('5',1.25,'001','011','Carton'),
  stockLine('6',99,'001','002'),
];
const stock=stockReport([stockHeader,...movements].join('\n'));
assert.deepEqual(stock.issues,[]);
assert.equal(stock.documents,5);
assert.equal(stock.codes,1);
assert.equal(stock.from,'2026-11-09');
assert.deepEqual(stock.items.find(row=>row.unit==='حبة'),{
  sapCode:'DAR00047',name:'Orasi',unit:'حبة',incoming:20,reverse:5,cancellation:-1,net:14,
});
assert.equal(stock.items.find(row=>row.unit==='كرتونة').net,1.25);
assert.equal(stockReport([stockHeader,stockLine('7','bad','009','011')].join('\n')).issues.length,1);
console.log('PASS: stock report separates units and handles inbound, reverse, and both cancellation directions.');
