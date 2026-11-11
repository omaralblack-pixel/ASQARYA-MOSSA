import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';

const cache=new Map();
function loadTs(file){
  file=resolve(file);
  if(cache.has(file))return cache.get(file);
  const exports={}; cache.set(file,exports);
  const {outputText,diagnostics}=ts.transpileModule(fs.readFileSync(file,'utf8'),{
    fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    reportDiagnostics:true,
  });
  assert.deepEqual(diagnostics?.filter(v=>v.category===ts.DiagnosticCategory.Error)||[],[]);
  new Function('exports','require',outputText)(exports,name=>{
    if(name.endsWith('.json'))return createRequire(file)(name);
    if(name.startsWith('.'))return loadTs(resolve(dirname(file),name+'.ts'));
    return createRequire(file)(name);
  });
  return exports;
}
const {sapInvoicesFromSavedFile,compareSapWithSavedInvoices}=loadTs('app/lib/sap-invoice-register.ts');
const header='رقم الترحيل\tتاريخ الترحيل\tكود الفرع\tاسم الفرع\tRemarks\tItem No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const row=(t,remark,from,to,qty='1',item='DAR00001')=>[t,'2026-11-11','21','السرو',remark,item,'Item description',qty,'Piece',from,to].join('\t');
const source=[
  header,
  row('2615823','2623013986','001','011'),
  row('2615823','2623013986','001','011','3','DAR00002'),
  row('2615824','2623013986','002','011'),
  row('2615825','2623013987','009','011'),
  row('2615826','2623013988','002','011'),
  row('2615827','2623013989','001','011'),
  row('2615828','2623013990','011','001'),
  row('2615829','2623013991 has been canceled','001','011','-1'),
  row('2615830','كاش فان بدون رقم فاتورة','001','011'),
].join('\n');
const extracted=sapInvoicesFromSavedFile(source);
assert.equal(extracted.invoices.length,4,'Only live outbound invoice transfers are included');
assert.deepEqual(extracted.invoices.find(i=>i.number==='2623013986').transfers,['2615823','2615824'],'Multiple item lines and transfers must not duplicate invoice');
assert.equal(extracted.invoices.some(i=>i.number==='2623013990'||i.number==='2623013991'),false,'Exclude reverse and canceled transfers');
assert.ok(extracted.withoutInvoice.includes('2615830'),'Unmapped cash van transfer must be visible for review');
const record=(id,number,complete,transfers)=>({
  id,branch:'السرو',doc_date:'2026-11-11',
  payload:JSON.stringify({invoices:[{number,complete,amount:'100.000'}],transfers:transfers.map(number=>({number}))}),
});
const saved=[
  record('received','2623013986',true,['2615823','2615824']),
  record('pending','2623013987',false,['2615825']),
  record('wrong-transfer','2623013989',true,['9999999']),
];
let checked=compareSapWithSavedInvoices(extracted,saved);
const byNumber=number=>checked.find(row=>row.number===number);
assert.equal(byNumber('2623013986').state,'received');
assert.equal(byNumber('2623013987').state,'pending');
assert.equal(byNumber('2623013988').state,'missing');
assert.equal(byNumber('2623013989').state,'review','Wrong linked transfer must not confirm physical paper');
assert.equal(checked.filter(row=>row.state!=='received').length,3);
checked=compareSapWithSavedInvoices(extracted,[...saved,record('duplicate','2623013986',true,['2615824'])]);
assert.equal(checked.find(row=>row.number==='2623013986').state,'review','Duplicate invoices must not be assumed confirmed');
const malformed=sapInvoicesFromSavedFile('غير صالح');
assert.ok(malformed.issues.length>0);
assert.equal(malformed.invoices.length,0);
console.log('PASS: permanent SAP invoice comparison deduplicates transfers, excludes reverse/canceled, and retains paper receipt distinctions');
