import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';

const cache=new Map();
function loadTs(file){
  file=resolve(file);
  if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  const result=ts.transpileModule(fs.readFileSync(file,'utf8'),{
    fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},reportDiagnostics:true,
  });
  assert.deepEqual(result.diagnostics?.filter(x=>x.category===ts.DiagnosticCategory.Error)||[],[]);
  new Function('exports','require',result.outputText)(exports,name=>
    name.startsWith('.')?loadTs(resolve(dirname(file),name+'.ts')):createRequire(file)(name));
  return exports;
}
const {reassure,reassuranceSource}=loadTs('app/lib/reassurance.ts');
const {collectInvoicesByDate}=loadTs('app/lib/invoice-collector.ts');
const date='2026-11-01',code='DAR00005';
const reference=[{code:'11371486',sapCode:code,name:'صنف مؤسسة',active:true,cartonPieces:20,kgPerPiece:0.2,sapUnit:'Piece',price:1000,invoicePack:1}];
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const paste=(qty,unit='Piece',from='001',to='011')=>header+'\n'+[code,'item',qty,unit,from,to].join('\t');
const card=(qty=100,number='2617001',unit='Piece',from='001',to='011')=>({id:number,number,date,paste:paste(qty,unit,from,to)});
const live=(qty=100,number='2617001',unit='Piece',from='001',to='011',extra={})=>({transfer:card(qty,number,unit,from,to),branch:'23 — خالد',remarks:'',lineCount:1,reverse:from==='011',signedAdjustment:qty<0,cancellationState:'active',cancellationMentioned:false,invoiceNumbers:[],issues:[],...extra});
const invoice=(qty=100,id='i1',number='2631000001')=>({id,number,date,amount:'100',complete:true,quantities:qty===null?{}:{'11371486':String(qty)}});
const record=(qty=100,extra={},invoices=[invoice(qty)],transfers=[card()])=>({id:'r1',branch:'23 — خالد',status:'match',payload:JSON.stringify({id:'r1',branch:'23 — خالد',date,invoices,transfers,referenceSnapshot:reference,...extra})});
const stock=(quantity,unit='Piece')=>({code,name:'item',warehouse:'011',unit,quantity});
function fixture({qty=100,actual=100,opening=0,records=[record(qty)],transfers=[live(actual-opening)],unit='Piece'}={}){
  return {from:date,to:date,data:{...collectInvoicesByDate(records,date,date),records,reference,openingStock:[]},transfers,sourceIssues:[],
    closing:{date,items:[stock(actual,unit)],issues:[]},opening:{date,items:[stock(opening,unit)],issues:[]}};
}
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS:',name);}
test('Exact match includes opening and does not mutate saved data',()=>{
  const input=fixture({opening:5,actual:105});const before=JSON.stringify(input);const report=reassure(input);
  assert.equal(report.state,'match');assert.equal(report.rows[0].expected,105);assert.equal(report.rows[0].difference,0);assert.equal(JSON.stringify(input),before);
});
test('Invoice shortfall proposes the exact transfer quantity',()=>{
  const report=reassure(fixture({actual:80}));assert.equal(report.state,'transfer');assert.equal(report.rows[0].difference,-20);
});
test('Excess actual stock identifies return review, not a negative transfer',()=>{
  const report=reassure(fixture({qty:80,actual:100}));assert.equal(report.state,'return');assert.equal(report.rows[0].difference,20);
});
test('Cartons and kg convert to pieces using verified pack factors',()=>{
  const carton=fixture({actual:5,unit:'Carton',transfers:[live(5,'2617001','Carton')]});
  assert.equal(reassure(carton).rows[0].actual,100);assert.equal(reassure(carton).state,'match');
  const kg=fixture({actual:20,unit:'KG',transfers:[live(20,'2617001','KG')]});assert.equal(reassure(kg).state,'match');
});
test('Financial approval is reported separately from paper-backed quantity equality',()=>{
  const recordRow={...record(),status:'review'};
  const report=reassure(fixture({records:[recordRow]}));
  assert.equal(report.state,'match','physical quantities may match without financial approval');
  assert.equal(report.financialPending,1);
  assert.equal(report.paperGroups,1);
  assert.equal(report.approvedGroups,0);
});
test('An invalid dated opening snapshot blocks a final confirmation',()=>{
  const input=fixture();input.opening.issues=['رصيد افتتاحي ناقص أو غير صالح'];
  const report=reassure(input);
  assert.equal(report.state,'review');
  assert.ok(report.issues.some(note=>note.includes('رصيد افتتاحي')));
});
test('Unconfirmed opening remains unknown, not zero',()=>{
  const input=fixture();input.opening=null;const report=reassure(input);assert.equal(report.state,'review');assert.equal(report.rows[0].opening,null);assert.equal(report.rows[0].difference,null);
});
test('Individual opening approval proves only its own item',()=>{
  const input=fixture({opening:5,actual:105});input.opening=null;input.data.openingStock=[{snapshot_date:date,warehouse:'011',sap_code:code,item_name:'item',unit:'Piece',quantity:5}];
  assert.equal(reassure(input).state,'match');
});
test('Missing closing item is not fabricated as zero',()=>{
  const input=fixture();input.closing.items=[];const report=reassure(input);assert.equal(report.state,'review');assert.equal(report.rows[0].actual,null);
});
test('Stale closing snapshot cannot prove a current transfer or return',()=>{
  const input=fixture({actual:80});input.to='2026-11-02';const report=reassure(input);assert.equal(report.state,'review');assert.equal(report.rows[0].difference,null);assert.ok(report.issues.some(x=>x.includes('تاريخ الفحص')));
});
test('Outdated transfer source blocks actionable claims even with a dated balance',()=>{
  const input=fixture({actual:80});input.to='2026-11-02';input.closing.date=input.to;
  assert.equal(reassure(input).rows[0].state,'review');
});
test('Financially approved group uses frozen quantities once for multiple invoices',()=>{
  const records=[record(null,{},[invoice(null),invoice(null,'i2','2631000002')])];
  const report=reassure(fixture({records}));assert.equal(report.state,'match');assert.equal(report.rows[0].invoices,100);assert.equal(report.approvedGroups,1);assert.equal(report.invoiceCount,2);
  const changed=reassure(fixture({records,actual:80}));assert.equal(changed.rows[0].difference,-20);assert.equal(changed.state,'transfer');
});
test('Partial invoice selection never spreads the approved group quantities',()=>{
  const other={...invoice(null,'i2','2631000002'),date:'2026-11-02'};
  const report=reassure(fixture({records:[record(null,{},[invoice(null),other])]}));assert.equal(report.state,'review');assert.equal(report.rows[0].invoices,null);assert.equal(report.approvedGroups,0);
});
test('Incomplete unapproved paper quantities block return recommendations',()=>{
  const recordRow={...record(null),status:'review'};
  const report=reassure(fixture({records:[recordRow]}));assert.equal(report.state,'review');assert.equal(report.pendingRecords.length,1);assert.equal(report.rows[0].difference,null);
});
test('Duplicate invoice numbers are not added twice',()=>{
  const records=[record(),{...record(),id:'r2'}];const report=reassure(fixture({records}));assert.equal(report.state,'review');assert.equal(report.rows[0].invoices,null);assert.equal(report.pendingRecords.length,2);
});
test('Signed correction and reverse movements retain their inventory effects',()=>{
  const transfers=[live(120),live(-10,'2617002'),live(10,'2617003','Piece','011','001')];
  const report=reassure(fixture({transfers}));assert.equal(report.state,'match');assert.equal(report.rows[0].netTransfers,100);assert.equal(report.rows[0].evidence.length,3);
});
test('Cancellation without its verified counterpart blocks reassurance',()=>{
  const transfers=[live(100,'2617001','Piece','001','011',{cancellationState:'canceled'})];
  const report=reassure(fixture({transfers}));assert.equal(report.state,'review');assert.ok(report.rows[0].notes.length);
});
test('Unexplained OINM versus transfers variance requests review',()=>{
  const report=reassure(fixture({actual:80,transfers:[live(100)]}));assert.equal(report.state,'review');assert.equal(report.rows[0].stockDifference,-20);
});
test('Missing or conflicting pack factors cannot claim a match',()=>{
  const input=fixture({actual:5,unit:'Carton',transfers:[live(5,'2617001','Carton')]});
  input.data.reference=[{...reference[0],cartonPieces:null}];const report=reassure(input);assert.equal(report.state,'review');assert.equal(report.rows[0].actual,null);
});
test('Invoice-free stock is visible as excess, not a fictitious invoice',()=>{
  const report=reassure(fixture({records:[]}));assert.equal(report.invoiceCount,0);assert.equal(report.rows[0].invoices,0);assert.equal(report.state,'return');
});
test('Blank undated transfer-only placeholders do not count as missing invoices',()=>{
  const emptyRecord={id:'empty',branch:'23 — خالد',status:'review',payload:JSON.stringify({invoices:[{id:'blank',number:'0',date:'',amount:'',quantities:{}}],transfers:[]})};
  const report=reassure(fixture({records:[record(),emptyRecord]}));assert.equal(report.state,'match');assert.equal(report.invoiceCount,1);
});
test('New shared source keeps recovered archive originals and newest document versions',()=>{
  const archive={key:'a',name:'archive',scan:{transfers:[live(100),live(20,'2617002')],issues:[]}};
  const sourceHeader='رقم الترحيل\tتاريخ الترحيل\tكود الفرع\tاسم الفرع\tRemarks\t'+header+'\tCANCELED';
  const text=sourceHeader+'\n'+['2617002','2026-11-02','23','خالد','',code,'item',-20,'Piece','001','011','N'].join('\t');
  const result=reassuranceSource(archive,{name:'new shared',text},['23 — خالد']);
  assert.equal(result.scan.transfers.length,2);assert.equal(result.scan.transfers.find(row=>row.transfer.number==='2617001').transfer.date,date);
  assert.ok(result.scan.transfers.find(row=>row.transfer.number==='2617002').transfer.paste.includes('-20'));
  assert.equal(reassuranceSource(archive,undefined,[]).scan,archive.scan);
});
console.log(`${passed} reassurance business-rule tests passed.`);
