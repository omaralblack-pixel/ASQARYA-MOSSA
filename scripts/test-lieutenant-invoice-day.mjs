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
    fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    reportDiagnostics:true,
  });
  assert.deepEqual(result.diagnostics?.filter(x=>x.category===ts.DiagnosticCategory.Error)||[],[]);
  new Function('exports','require',result.outputText)(exports,name=>
    name.startsWith('.')?loadTs(resolve(dirname(file),name+'.ts')):createRequire(file)(name));
  return exports;
}
const {auditInvoicesForDay}=loadTs('app/lib/lieutenant-invoice-day.ts');
const {collectInvoicesByDate}=loadTs('app/lib/invoice-collector.ts');
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const ref=(code,sapCode,cartonPieces=1)=>({
  code,sapCode,name:'صنف '+code,price:1000,invoicePack:null,cartonPieces,
  sapUnit:'Piece',kgPerPiece:null,active:true,
});
const reference=[ref('11371486','DAR00005',20),ref('11064245','CHS00033')];
const line=(code,quantity,unit='Piece',from='001',to='011')=>
  [code,'item',quantity,unit,from,to].join('\t');
const paste=(...rows)=>header+'\n'+rows.join('\n');
const card=(number,date,...rows)=>({id:'t-'+number,number,date,paste:paste(...rows)});
const savedInvoice=(id,number,date,qty,code='11371486')=>({
  id,number,date,amount:String(qty),complete:true,quantities:{[code]:String(qty)},
});
const record=(invoices,transfers,other={})=>({
  id:'r1',branch:'23 — خالد',status:'match',
  payload:JSON.stringify({id:'r1',branch:'23 — خالد',date:'2026-11-01',
    invoices,transfers,referenceSnapshot:reference,...other}),
});
const live=(number,date,rows,{cancellationState='active',reverse=false,signedAdjustment=false}={})=>({
  transfer:card(number,date,...rows),branch:'23 — خالد',remarks:'',lineCount:rows.length,
  reverse,cancellationState,cancellationMentioned:false,signedAdjustment,issues:[],invoiceNumbers:[],
});
const audit=(records,transfers,asOf,day='2026-11-01')=>
  auditInvoicesForDay({...collectInvoicesByDate(records,day,day),records},transfers,asOf,reference).rows;
const paper=savedInvoice('i1','2631000001','2026-11-01',100);
const saved=card('2617001','2026-11-03',line('DAR00005',100));
const src=live('2617001','2026-11-03',[line('DAR00005',100)]);

const future=audit([record([paper],[saved])],[src],'2026-11-02');
assert.equal(future.length,1);
assert.equal(future[0].state,'pending','Future postings must not count as already received');
assert.equal(future[0].items[0].posted,0);
const later=audit([record([paper],[saved])],[src],'2026-11-03');
assert.equal(later[0].state,'late','Invoice day and SAP posting day must be independent');
assert.equal(later[0].items[0].posted,100);
const present=audit([record([paper],[saved])],[live('2617001','2026-11-01',[line('DAR00005',100)])],'2026-11-01');
assert.equal(present[0].state,'match','Same-day receipt must be matched without delay label');
const partial=audit([record([paper],[saved])],[live('2617001','2026-11-03',[line('DAR00005',80)])],'2026-11-03');
assert.equal(partial[0].state,'short');
assert.equal(partial[0].items[0].difference,20);
const excess=audit([record([paper],[saved])],[live('2617001','2026-11-03',[line('DAR00005',120)])],'2026-11-03');
assert.equal(excess[0].state,'extra');
assert.equal(excess[0].items[0].difference,-20);
const canceled=audit([record([paper],[saved])],[live('2617001','2026-11-03',[line('DAR00005',100)],{cancellationState:'canceled'})],'2026-11-03');
assert.equal(canceled[0].state,'pending','SAP-canceled postings must not be counted as effective receipt');

const paper2=savedInvoice('i2','2631000002','2026-11-01',12,'11064245');
const mixed=card('2617002','2026-11-03',line('DAR00005',100),line('CHS00033',12));
const group=record([paper,paper2],[mixed],{pages:{'i:11371486':'1','i:11064245':'2'}});
const grouped=audit([group],[live('2617002','2026-11-03',[line('DAR00005',100),line('CHS00033',12)])],'2026-11-03');
assert.equal(grouped.length,2);
assert.deepEqual(grouped.map(x=>x.state),['late','late'],
  'Confirmed per-page allocations must not double-count an SAP transfer');
assert.deepEqual(grouped.map(x=>x.items.map(y=>y.code)),[['11371486'],['11064245']]);
assert.equal(grouped.reduce((sum,x)=>sum+x.items.reduce((n,item)=>n+(item.posted??0),0),0),112,
  'Shared SAP lines may be counted only once across both blue invoices');

const unallocated=audit([record([paper,paper2],[mixed])],
  [live('2617002','2026-11-03',[line('DAR00005',100),line('CHS00033',12)])],'2026-11-03');
assert.deepEqual(unallocated.map(x=>x.state),['review','review'],
  'Multiple invoices without verified page allocations may not be marked matched');
assert.ok(unallocated.every(x=>x.financiallyMatchedGroup),
  'Saved group-level financial approval should remain visible without pretending quantity approval');

const notEnough=audit([record([paper],[saved])],
  [live('2617001','2026-11-02',[line('DAR00005',80)])],'2026-11-05');
assert.equal(notEnough[0].state,'review',
  'If the SAP source does not reach audit cutoff, missing quantity is unverified');

// SAP stock posting, not the blue-invoice date, determines the receipt.
const cartons=audit([record([paper],[saved])],
  [live('2617001','2026-11-03',[line('DAR00005',5,'Carton')])],'2026-11-03');
assert.equal(cartons[0].state,'late');
assert.equal(cartons[0].items[0].posted,100,'Carton quantity must use the recorded SAP pack definition');

// Signed SAP corrections are not rejected as ordinary negative invoice rows.
const signed=live('2617004','2026-11-05',[line('DAR00005',-20)],{signedAdjustment:true});
signed.remarks='Inventory transfer no. 2617001 has been canceled';
const beforeCorrection=audit([record([paper],[saved])],[src,signed],'2026-11-03');
assert.equal(beforeCorrection[0].state,'late','Future correction must not backdate its stock effect');
const afterCorrection=audit([record([paper],[saved])],[src,signed],'2026-11-05');
assert.equal(afterCorrection[0].state,'short');
assert.equal(afterCorrection[0].items[0].posted,80);
assert.equal(afterCorrection[0].items[0].difference,20);

// A partial reverse with an explicit original number reduces coverage.
const reverse=live('2617010','2026-11-05',[line('DAR00005',20,'Piece','011','001')],{reverse:true});
reverse.remarks='عكس ترحيل 2617001';
const afterReverse=audit([record([paper],[saved])],[src,reverse],'2026-11-05');
assert.equal(afterReverse[0].state,'short');
assert.equal(afterReverse[0].items[0].posted,80);

// CANCELED=Y is today's flag; a dated SAP cancellation on the 5th must not
// cause a false historical shortage on the 3rd.
const laterCanceled=live('2617001','2026-11-03',[line('DAR00005',100)],{cancellationState:'canceled'});
const cancelDocument=live('2617020','2026-11-05',[line('DAR00005',100,'Piece','011','001')],
  {cancellationState:'cancellation',reverse:true});
cancelDocument.remarks='Inventory transfer no. 2617001 has been canceled';
assert.equal(audit([record([paper],[saved])],[laterCanceled,cancelDocument],'2026-11-03')[0].state,'late');
assert.equal(audit([record([paper],[saved])],[laterCanceled,cancelDocument],'2026-11-05')[0].state,'pending');

const pastedPaper=record([{...paper,quantities:{},
  auditLines:'رقم المادة\tالكمية\n11371486\t100'}],[saved]);
assert.equal(audit([pastedPaper],[src],'2026-11-03')[0].state,'late',
  'Pasted invoice column headers must not create false item errors');

const missingAmounts=record([{...paper,quantities:{},auditLines:''}],[saved]);
const missingPaperResult=audit([missingAmounts],[src],'2026-11-03')[0];
assert.equal(missingPaperResult.state,'financial-late',
  'Saved financial approval must be visible without claiming item-level quantity matching');
assert.equal(missingPaperResult.financiallyMatchedGroup,true);
assert.equal(missingPaperResult.items[0].expected,null,
  'Unknown paper quantity must never appear as zero');
assert.equal(missingPaperResult.items[0].posted,100,
  'Known SAP receipt remains visible even when the paper quantity is unknown');
assert.equal(missingPaperResult.items[0].difference,null,
  'Unknown paper quantity must never generate a fake negative variance');
const missingPaperOnSameDay=audit([missingAmounts],
  [live('2617001','2026-11-01',[line('DAR00005',100)])],'2026-11-01')[0];
assert.equal(missingPaperOnSameDay.state,'financial',
  'A financially approved invoice with no paper quantities is not a verified quantity match');
const notYetPosted=audit([missingAmounts],[src],'2026-11-02')[0];
assert.equal(notYetPosted.state,'financial');
assert.equal(notYetPosted.items[0].posted,0);
assert.equal(notYetPosted.items[0].expected,null);
assert.ok(notYetPosted.notes.some(note=>note.includes('بعد تاريخ الفحص')),
  'Later SAP transfers must not be represented as already posted');
const unapprovedMissing=audit([{...missingAmounts,status:'review'}],[src],'2026-11-03')[0];
assert.equal(unapprovedMissing.state,'review',
  'An unapproved invoice must never inherit financial approval');
const unknownSplit=record([{...paper,quantities:{},auditLines:''},
  {...paper2,quantities:{},auditLines:''}],[mixed]);
const financiallyApprovedSplit=audit([unknownSplit],
  [live('2617002','2026-11-03',[line('DAR00005',100),line('CHS00033',12)])],
  '2026-11-03');
assert.deepEqual(financiallyApprovedSplit.map(row=>row.state),['financial','financial'],
  'Previously approved financial groups remain visible without inventing per-page quantities');
assert.ok(financiallyApprovedSplit.every(row=>row.items.every(item=>item.difference===null)),
  'Unallocated legacy group rows may not create fake quantity differences');
const malformedPaper=record([{...paper,auditLines:'11371486\t100\nINVALID\t3'}],[saved]);
const malformedResult=audit([malformedPaper],[src],'2026-11-03')[0];
assert.equal(malformedResult.items[0].expected,null,
  'Partially parsed invoice lines must not be treated as a complete invoice');
assert.equal(malformedResult.state,'review',
  'Invalid source rows remain a review, not financial-only acceptance');
assert.equal(malformedResult.items[0].difference,null);
assert.deepEqual(JSON.parse(group.payload).invoices,[paper,paper2],
  'Read-only audit must not mutate previously saved invoices');
const endpoint=fs.readFileSync('app/api/reconcile/route.ts','utf8');
assert.ok(endpoint.includes("u.searchParams.has('lieutenantInvoiceDay')"));
assert.ok(endpoint.includes('collectInvoicesByDate(records.results,day,day)'));
const screen=fs.readFileSync('app/reconciliation/FirstLieutenant.tsx','utf8');
assert.ok(screen.includes('فحص جميع فواتير هذا اليوم'));
assert.ok(screen.includes('auditInvoicesForDay(dailyInvoices,transfers,invoiceAsOf,reference)'));
assert.ok(screen.includes('معتمدة ماليًا فقط'));
assert.ok(screen.includes("dailyCounts.financial+dailyCounts['financial-late']"));
console.log('PASS: Daily blue-invoice date, SAP cutoff, delay, shortage, cancellation, page allocation and no-write safeguards.');
