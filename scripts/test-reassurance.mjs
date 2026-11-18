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
test('Lieutenant Supabase archive is authoritative over a newer-dated legacy shared export',()=>{
  const archive={key:'a',name:'archive',scan:{transfers:[live(100),live(20,'2617002')],issues:[]}};
  const sourceHeader='رقم الترحيل\tتاريخ الترحيل\tكود الفرع\tاسم الفرع\tRemarks\t'+header+'\tCANCELED';
  const text=sourceHeader+'\n'+['2617002','2026-11-02','23','خالد','',code,'item',-20,'Piece','001','011','N'].join('\t');
  const chosen=reassuranceSource(archive,{name:'shared newer posting',text},['23 — خالد']);
  assert.equal(chosen.scan,archive.scan);
  assert.equal(chosen.name,'archive');
  assert.ok(chosen.scan.transfers.find(row=>row.transfer.number==='2617002').transfer.paste.includes('\t20\t'),
    'latest immutable archive must not be silently replaced by an old shared upload');
  assert.equal(reassuranceSource(archive,undefined,[]).scan,archive.scan);
  assert.equal(reassuranceSource(null,{name:'fallback',text},['23 — خالد']).name,'fallback',
    'the shared export is permitted only when no lieutenant archive exists');
});
test('Shows the exact unlinked full-document incoming movement as a cancellation-review candidate',()=>{
  const input=fixture({qty:88,actual:100,
    records:[record(88,{},[invoice(88)],[card(88,'2617999')])],
    transfers:[live(88,'2617999'),live(12,'2617112')]});
  const row=reassure(input).rows[0];
  assert.equal(row.difference,12);
  assert.deepEqual(row.candidates.map(doc=>doc.number),['2617112']);
  assert.equal(row.candidates[0].quantity,12);
  assert.equal(row.candidates[0].direction,'إلغاء وارد إلى 011');
  assert.equal(row.candidates[0].stockUnexplained,false);
});
test('Never proposes canceling a transfer already tied to an invoice record',()=>{
  const input=fixture({qty:88,actual:100,
    records:[record(88,{},[invoice(88)],[card(88,'2617999'),card(12,'2617112')])],
    transfers:[live(88,'2617999'),live(12,'2617112')]});
  assert.deepEqual(reassure(input).rows[0].candidates,[]);
});
test('Never selects a wrong-direction or already canceled transfer just because its quantity is 12',()=>{
  const rows=(candidate)=>reassure(fixture({qty:88,actual:100,
    records:[record(88,{},[invoice(88)],[card(88,'2617999')])],
    transfers:[live(88,'2617999'),candidate]})).rows[0];
  assert.deepEqual(rows(live(12,'2617112','Piece','011','001')).candidates,[]);
  assert.deepEqual(rows(live(12,'2617112','Piece','001','011',
    {cancellationState:'canceled'})).candidates,[]);
});
test('An unrelated second item prevents canceling an entire multi-item document',()=>{
  const candidate=live(12,'2617112');
  candidate.transfer.paste+='\n'+['CHS00012','Unrelated product',8,'Piece','001','011'].join('\t');
  candidate.lineCount=2;
  const input=fixture({qty:88,actual:100,
    records:[record(88,{},[invoice(88)],[card(88,'2617999')])],
    transfers:[live(88,'2617999'),candidate]});
  assert.deepEqual(reassure(input).rows.find(row=>row.code===code).candidates,[]);
});
test('2616469 Cash Van matched by 2616571 is settled and never listed for SAP cancellation',()=>{
  const original=live(12,'2616469','Piece','002','011',{
    branch:'23 — خالد',remarks:'كاش فان إربد',
    transfer:{...card(12,'2616469','Piece','002','011'),date:'2026-11-12'},
  });
  const reverse=live(12,'2616571','Piece','011','002',{
    branch:'23 — خالد',remarks:'عكسي ترحيل 2616469',
    transfer:{...card(12,'2616571','Piece','011','002'),date:'2026-11-14'},
  });
  const other=live(12,'2616999','Piece','001','011',{
    transfer:{...card(12,'2616999'),date:'2026-11-18'},
  });
  const input=fixture({qty:100,actual:112,transfers:[live(100,'2617999'),original,reverse,other]});
  input.to='2026-11-18';input.closing.date=input.to;
  const report=reassure(input),row=report.rows.find(row=>row.code===code);
  assert.equal(row.difference,12);
  assert.equal(row.netTransfers,112,'full reversal offsets 2616469 to zero');
  assert.deepEqual(row.candidates.map(item=>item.number),['2616999']);
  assert.deepEqual(report.settlements.find(item=>item.number==='2616469')?.counterparts,['2616571']);
  assert.match(report.settlements.find(item=>item.number==='2616469')?.note||'',/صافي الحركة صفر/);
  assert.ok(!report.settlements.some(item=>item.number==='2616571'),'reverse must not create a duplicate settlement');
  input.to='2026-11-13';input.closing.date=input.to;
  const earlier=reassure(input);
  assert.ok(!earlier.settlements.some(item=>item.number==='2616469'),
    'a reversal posted after the selected date cannot settle an earlier snapshot');
});
test('Partial Cash Van reverse does not authorize canceling the complete original',()=>{
  const original=live(12,'2616469','Piece','002','011',{remarks:'كاش فان إربد'});
  const partial=live(6,'2616571','Piece','011','002',{remarks:'عكسي ترحيل 2616469'});
  const input=fixture({qty:88,actual:100,
    records:[record(88,{},[invoice(88)],[card(88,'2617999')])],
    transfers:[live(88,'2617999'),original,partial,live(6,'2616888')]});
  const report=reassure(input);
  assert.deepEqual(report.rows[0].candidates.map(item=>item.number),[],
    'no full original cancellation from partially reversed Cash Van');
  assert.deepEqual(report.settlements,[]);
});
const {buildReassuranceCouncil}=loadTs('app/lib/reassurance-council.ts');
const control={days:[{day:date,invoices_complete:1,confirmed_at:'',confirmed_by:'operator'}],
  assignments:[],decisions:[],signoffs:[]};
test('Tammeni reads the soldier project ledger and colonel day statuses without inventing Saja Excel evidence',()=>{
  const council=buildReassuranceCouncil({from:date,to:date,
    records:[record()],transfers:[live()],controls:[control],sourceReady:true});
  assert.equal(council.soldier.invoices,1);
  assert.equal(council.soldier.paperPending,0);
  assert.equal(council.soldier.sajaAvailable,false);
  assert.equal(council.colonel.invoiceDays,1);
  assert.equal(council.colonel.readyDays,1);
  assert.equal(council.colonel.openTransfers,0);
});
test('Repeated invoice numbers, unresolved paper and missing day confirmations stay visible from source',()=>{
  const second={...record(),id:'r2',payload:record().payload.replace('2631000001','2631000001')};
  const first=record();
  const council=buildReassuranceCouncil({from:date,to:date,
    records:[first,second],transfers:[live()],controls:[{...control,days:[]}],sourceReady:true});
  assert.ok(council.soldier.duplicates>=2);
  assert.ok(council.findings.some(item=>item.source==='soldier'&&item.title.includes('مكرر')));
  assert.ok(council.findings.some(item=>item.source==='colonel'&&item.title.includes('يوم')));
});
test('Tammeni cross-agent council respects the lieutenant fully reversed Cash Van pair',()=>{
  const orig=live(12,'2616469','Piece','002','011',{
    branch:'23 — خالد',remarks:'كاش فان إربد',
    transfer:{...card(12,'2616469','Piece','002','011'),date:'2026-11-12'},
  });
  const reverse=live(12,'2616571','Piece','011','002',{
    branch:'23 — خالد',remarks:'عكسي ترحيل 2616469',
    transfer:{...card(12,'2616571','Piece','011','002'),date:'2026-11-14'},
  });
  const pending=live(12,'2616702','Piece','002','011',{
    branch:'23 — خالد',remarks:'كاش فان جرش',
    transfer:{...card(12,'2616702','Piece','002','011'),date:'2026-11-16'},
  });
  const result=buildReassuranceCouncil({from:'2026-11-01',to:'2026-11-18',
    records:[record()],transfers:[live(),orig,reverse,pending],
    controls:[control],sourceReady:true});
  assert.ok(result.lieutenant.reversed>=1);
  assert.ok(result.lieutenant.cashVanPending>=1);
  assert.ok(!result.findings.some(item=>item.title==='العقيد بحاجة حسم ترحيل'&&
    item.transferNo==='2616469'),'do not reopen settled originals as cancellation recommendations');
  assert.ok(result.findings.some(item=>item.transferNo==='2616702'&&item.source==='lieutenant'));
});

console.log(`${passed} reassurance business-rule tests passed.`);

const {restoreUnifiedStockSnapshots}=loadTs('app/lib/lieutenant-source.ts');
const {unifiedSapQuery}=loadTs('app/lib/unified-sap-query.ts');
const unifiedSql=unifiedSapQuery('2026-11-01','2026-11-17');
const unifiedHeaders=[...unifiedSql.split('\nUNION ALL\n')[0].matchAll(/ AS "([^"]+)"/g)].map(match=>match[1]);
const unifiedRow=values=>unifiedHeaders.map(key=>String(values[key]??'')).join('\t');
const unifiedText=[
 unifiedHeaders.join('\t'),
 unifiedRow({RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:'2026-11-17'}),
 unifiedRow({RecordType:'OPENING',DocumentDate:'2026-11-01',ItemCode:code,ItemName:'item',
   Warehouse:'011',Unit:'Piece',StockQuantity:'5'}),
 unifiedRow({RecordType:'CLOSING',DocumentDate:'2026-11-17',ItemCode:code,ItemName:'item',
   Warehouse:'011',Unit:'Piece',StockQuantity:'105'}),
].join('\n');
const onlyUnified=[{key:'unified',name:'SAP-all.txt',kind:'unified',created:'2026-11-17T11:27:22Z'}];
const recovered=await restoreUnifiedStockSnapshots(onlyUnified,'2026-11-01','2026-11-17',async()=>unifiedText);
assert.equal(recovered.opening?.file.snapshotDate,'2026-11-01');
assert.equal(recovered.closing?.file.snapshotDate,'2026-11-17');
assert.equal(recovered.opening?.stock.items[0].quantity,5);
assert.equal(recovered.closing?.stock.items[0].quantity,105);
const fromRecovered=fixture({opening:5,actual:105});
fromRecovered.from='2026-11-01';fromRecovered.to='2026-11-17';
fromRecovered.opening={date:recovered.opening.file.snapshotDate,...recovered.opening.stock};
fromRecovered.closing={date:recovered.closing.file.snapshotDate,...recovered.closing.stock};
fromRecovered.transfers=[live(100,'2617001','Piece','001','011',{transfer:{...card(),date:'2026-11-17'}})];
const verifiedReport=reassure(fromRecovered);
assert.equal(verifiedReport.rows[0].actual,105);
assert.equal(verifiedReport.rows[0].opening,5);
assert.equal(verifiedReport.rows[0].expected,105);
const stale=await restoreUnifiedStockSnapshots(onlyUnified,'2026-11-01','2026-11-18',async()=>unifiedText);
assert.equal(stale.closing?.file.snapshotDate,'2026-11-17',
 'Original SAP date, not upload date or selected date, governs the comparison');
const unmatchedOpening=await restoreUnifiedStockSnapshots(onlyUnified,'2026-11-02','2026-11-17',async()=>unifiedText);
assert.equal(unmatchedOpening.opening,null,'Do not invent opening stock for another day');
const missingClosing=unifiedText.split('\n').filter(row=>!row.startsWith('CLOSING\t')).join('\n');
const insufficient=await restoreUnifiedStockSnapshots(onlyUnified,'2026-11-01','2026-11-17',async()=>missingClosing);
assert.equal(insufficient.closing,null,'A missing CLOSING section never proves zero stock');
const legacy=await restoreUnifiedStockSnapshots([{...onlyUnified[0],kind:'other'}],'2026-11-01','2026-11-17',async()=>unifiedText);
assert.equal(legacy.closing?.stock.items[0].quantity,105,'Recover a misclassified older unified original');
console.log('PASS: Tammeni restores dated stock from a unified SAP original without separate derived archives, rejecting missing or mismatched evidence');

