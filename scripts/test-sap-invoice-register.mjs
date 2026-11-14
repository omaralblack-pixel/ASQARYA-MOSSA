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
// Regression guards for confusing SAP-only, saved, checked, and unregistered invoices.
for(const file of ['app/reconciliation/InvoiceRegister.tsx',
                   'app/reconciliation/InstantMatch.tsx',
                   'app/reconciliation/SerialSoldier.tsx',
                   'app/lib/serial-soldier.ts']){
  const parsed=ts.transpileModule(fs.readFileSync(file,'utf8'),{
    fileName:file,
    compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
    reportDiagnostics:true,
  });
  assert.deepEqual((parsed.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error),[],
    file+' should have valid TS/TSX syntax');
}
const registry=fs.readFileSync('app/reconciliation/InvoiceRegister.tsx','utf8');
assert.ok(registry.includes('const rows = searching ? [...received, ...pending]'),
  'Invoice search must find both paper-checked and unchecked saved records');
assert.ok(registry.includes('return invoiceDocumentNo(row.values[0]) === searched;'),
  'Full invoice-number search must match the actual saved invoice number');
assert.ok(registry.includes('const sapOnlySearchMatch'),
  'A SAP Remarks match without a saved record must be separately identified');
const instant=fs.readFileSync('app/reconciliation/InstantMatch.tsx','utf8');
assert.ok(instant.includes('مطابق ماليًا — إجمالي المجموعة'),
  'A multi-invoice total must not imply invoice-by-invoice page approval');
const serialScreen=fs.readFileSync('app/reconciliation/SerialSoldier.tsx','utf8');
assert.ok(serialScreen.includes("missing:'غير مسجلة بالمشروع'"),
  'Missing project registrations must not be called physically missing paper');
assert.ok(instant.includes("const latestRecords = await refreshRecords();"),
  'Last-four-digit lookup must refresh D1 records before concluding no suggestions exist');
assert.ok(instant.includes('هذا بحث مبدئي، وليس إثباتًا'),
  'Empty autocomplete must not be presented as proof of missing invoice paper');
assert.ok(instant.includes('فتحته كفاتورة جديدة غير محفوظة'),
  'Full-number lookup should disclose when a new draft is not a saved invoice');
console.log('PASS: Invoice search checks all statuses, SAP-only results stay distinct, financial matches do not imply page allocations.');

console.log('PASS: permanent SAP invoice comparison deduplicates transfers, excludes reverse/canceled, and retains paper receipt distinctions');

const {sapInvoiceNumbers,withSapInvoiceNumbers}=loadTs('app/lib/reconcile.ts');
const {parseSapImport}=loadTs('app/lib/sap-import.ts');
const {parseLieutenantTransfers}=loadTs('app/lib/lieutenant.ts');
const remarksCases=[
  ['فاتورة زرقاء رقم: 2630806229 — فرع السرو',['2630806229']],
  ['فرع السرو || فاتورة ٢٦٣٠٨٠٦٢٢٩ و ۲۶۳۰۸۰۶۲۳۰',['2630806229','2630806230']],
  ['2630806229 / 2630806230، 2630806229',['2630806229','2630806230']],
  ['2630806229 Based On Inventory Transfer Request 1234567890',['2630806229']],
  ['Based On Inventory Transfer Request 1234567890 || فاتورة 2630806229',['2630806229']],
  ['ترحيل 2616391 بتاريخ 14/11/2026 بدون فاتورة',[]],
  ['126308062291 0000000000',[]],
  ['فاتورة \u200f2630806229\u200e',['2630806229']],
];
for(const [remarks,expected] of remarksCases){
  assert.deepEqual(sapInvoiceNumbers(remarks),expected,remarks);
  const file=[header,row('2616391',remarks,'001','011')].join('\n');
  assert.deepEqual(parseSapImport(file,['21 — السرو']).groups[0].members[0].invoices,expected);
  assert.deepEqual(sapInvoicesFromSavedFile(file).invoices.map(i=>i.number).sort(),[...expected].sort());
  assert.deepEqual(parseLieutenantTransfers(file,['21 — السرو']).transfers[0].invoiceNumbers,expected);
}
const blank={branch:'',driver:'',date:'2026-11-14',notes:'',transfers:[],invoices:[{
  id:'invoice-1',number:'',date:'',amount:'',complete:false,quantities:{},attachments:[],
}]};
const populated=withSapInvoiceNumbers(blank,['2630806229','2630806230','2630806229'],'2616391');
assert.deepEqual(populated.invoices.map(i=>i.number),['2630806229','2630806230']);
assert.equal(populated.invoices[0].id,'invoice-1');
assert.equal(new Set(populated.invoices.map(i=>i.id)).size,2);
assert.deepEqual(blank.invoices.map(i=>i.number),[''],'Input is immutable');
for(const changes of [{number:'2630806000'},{manualNumber:true},{amount:'10.000'},
  {complete:true},{quantities:{item:'2'}},{attachments:[{key:'a'}]},{auditLines:'saved lines'}]){
 const draft={...blank,invoices:[{...blank.invoices[0],...changes}]};
 assert.equal(withSapInvoiceNumbers(draft,['2630806229'],'2616391'),draft,'Preserve existing invoice work');
}
assert.equal(withSapInvoiceNumbers({...blank,id:'saved'},['2630806229'],'2616391').invoices[0].number,'');
assert.equal(withSapInvoiceNumbers(populated,['2630806000'],'2616392'),populated);
console.log('PASS: labeled/bilingual Remarks, multiple invoices, SAP request exclusion and protected manual/saved invoice cards.');
