import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const rec=data(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const collector=data(compile(fs.readFileSync('app/lib/invoice-collector.ts','utf8').replace("'./reconcile'","'"+rec+"'")));
const exporter=fs.readFileSync('app/lib/project-invoice-export.ts','utf8')
.replace("'./reconcile'","'"+rec+"'").replace("'./invoice-collector'","'"+collector+"'")
.replace("'fflate'","'"+import.meta.resolve('fflate')+"'");
const {projectInvoiceExportRows,createProjectInvoicesWorkbook}=await import(data(compile(exporter)));
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const transfer=(number,from,to)=>({number,paste:header+'\nDAR00001\tItem\t1\tPiece\t'+from+'\t'+to});
const saved=(id,number,amount,date,transfers,branch='فرع أ')=>({id,branch,status:'match',payload:JSON.stringify({
invoices:[{id:'i-'+id,number,amount,date,complete:true}],transfers,summary:{status:'match'}})});
const records=[
saved('one','2621610051','176.920','2026-11-07',[transfer('2616104','001','011')]),
saved('duplicate','2621610051','176.920','2026-11-07',[transfer('2616105','002','011')]),
saved('conflict','2621610051','177.000','2026-11-07',[transfer('2616106','011','001')],'فرع ب'),
saved('single','2621610052','0','2026-11-08',[transfer('2616107','001','011')]),
saved('undated','2621610053','8.500','',[])
];
const snapshot=JSON.stringify(records);
const rows=projectInvoiceExportRows(records);
assert.equal(rows.length,3);
assert.equal(new Set(rows.map(row=>row.number)).size,3);
const invoice=rows.find(row=>row.number==='2621610051');
assert.equal(invoice.status,'رقم مكرر — يحتاج مراجعة');
assert.ok(invoice.notes.includes('176.920 / 177.000'));
assert.ok(invoice.notes.includes('فرع أ / فرع ب'));
assert.deepEqual(invoice.recordIds.split('، '),['one','duplicate','conflict']);
assert.equal(invoice.main,'2616104');
assert.equal(invoice.dry,'2616105');
assert.equal(invoice.adjustments,'2616106');
assert.equal(invoice.amountFils,null);
assert.equal(rows.find(row=>row.number==='2621610052').amountFils,0);
assert.ok(rows.some(row=>row.number==='2621610053'));
const blob=createProjectInvoicesWorkbook(records);
assert.equal(blob.type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
const zip=unzipSync(new Uint8Array(await blob.arrayBuffer()));
for(const name of ['[Content_Types].xml','xl/workbook.xml','xl/worksheets/sheet1.xml','xl/styles.xml'])
 assert.ok(zip[name],name+' missing');
const xml=strFromU8(zip['xl/worksheets/sheet1.xml']);
assert.equal((xml.match(/<row r="/g)||[]).length,4);
assert.equal((xml.match(/2621610051/g)||[]).length,1);
assert.ok(xml.includes('176.920 / 177.000'));
assert.ok(xml.includes('<v>0</v>'));
assert.equal(JSON.stringify(records),snapshot);
console.log('PASS: Excel, one row per number, conflict audit, zero values, undated rows and immutable source.');
