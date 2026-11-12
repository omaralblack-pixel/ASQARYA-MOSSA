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
  id:'r1',branch:'23 — خالد',status:'review',
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
assert.ok(unallocated.every(x=>!x.financiallyMatchedGroup),
  'Unapproved groups must not inherit a saved approval');

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

const missingAmounts={...record([{...paper,quantities:{},auditLines:''}],[saved]),status:'match'};
const missingPaperResult=audit([missingAmounts],[src],'2026-11-03')[0];
assert.equal(missingPaperResult.state,'late',
  'The operator-approved invoice must be matched, with SAP delay kept visible');
assert.equal(missingPaperResult.financiallyMatchedGroup,true);
assert.equal(missingPaperResult.items[0].expected,null,
  'Unknown paper quantity must never appear as zero');
assert.equal(missingPaperResult.items[0].posted,100,
  'Known SAP receipt remains visible even when the paper quantity is unknown');
assert.equal(missingPaperResult.items[0].difference,null,
  'Unknown paper quantity must never generate a fake negative variance');
const missingPaperOnSameDay=audit([missingAmounts],
  [live('2617001','2026-11-01',[line('DAR00005',100)])],'2026-11-01')[0];
assert.equal(missingPaperOnSameDay.state,'match',
  'Saved financial approval must remain matched without re-entering paper quantities');
const notYetPosted=audit([missingAmounts],[src],'2026-11-02')[0];
assert.equal(notYetPosted.state,'match','The saved invoice approval must not be reopened by the SAP cutoff');
assert.equal(notYetPosted.items.length,0,
  'A future-only SAP posting and absent paper quantities must not invent an item amount');
assert.ok(notYetPosted.notes.some(note=>note.includes('بعد تاريخ الفحص')),
  'Later SAP transfers must not be represented as already posted');
const unapprovedMissing=audit([{...missingAmounts,status:'review'}],[src],'2026-11-03')[0];
assert.equal(unapprovedMissing.state,'review',
  'An unapproved invoice must never inherit financial approval');
const unknownSplit={...record([{...paper,quantities:{},auditLines:''},
  {...paper2,quantities:{},auditLines:''}],[mixed]),status:'match'};
const financiallyApprovedSplit=audit([unknownSplit],
  [live('2617002','2026-11-03',[line('DAR00005',100),line('CHS00033',12)])],
  '2026-11-03');
assert.deepEqual(financiallyApprovedSplit.map(row=>row.state),['late','late'],
  'Previously approved financial groups must match without inventing per-page quantities');
assert.ok(financiallyApprovedSplit.every(row=>row.postedDates.includes('2026-11-03')),
  'The dates of approved group transfers remain visible without page allocation');
assert.equal(financiallyApprovedSplit.reduce((sum,row)=>sum+row.items.reduce((n,item)=>n+(item.posted??0),0),0),0,
  'Matching an approved shared group must not invent or duplicate invoice-level quantities');
assert.ok(financiallyApprovedSplit.every(row=>row.items.every(item=>item.difference===null)),
  'Unallocated legacy group rows may not create fake quantity differences');
const malformedPaper=record([{...paper,auditLines:'11371486\t100\nINVALID\t3'}],[saved]);
const malformedResult=audit([malformedPaper],[src],'2026-11-03')[0];
assert.equal(malformedResult.items[0].expected,null,
  'Partially parsed invoice lines must not be treated as a complete invoice');
assert.equal(malformedResult.state,'review',
  'Invalid source rows remain a review, not financial-only acceptance');
assert.equal(malformedResult.items[0].difference,null);
const approvedMalformed=audit([{...malformedPaper,status:'match'}],[src],'2026-11-03')[0];
assert.equal(approvedMalformed.state,'late',
  'Incomplete saved quantity details must not reopen the operator approval');
assert.equal(approvedMalformed.items[0].expected,null);
const approvedUnallocated=audit([{...group,status:'match',
  payload:JSON.stringify({...JSON.parse(group.payload),pages:{}})}],
  [live('2617002','2026-11-03',[line('DAR00005',100),line('CHS00033',12)])],'2026-11-03');
assert.deepEqual(approvedUnallocated.map(row=>row.state),['late','late'],
  'Saved approval must not require reassigning previously checked pages');
const staleSummary={...missingAmounts,status:'review',
  payload:JSON.stringify({...JSON.parse(missingAmounts.payload),summary:{status:'match'}})};
assert.equal(audit([staleSummary],[src],'2026-11-03')[0].state,'review',
  'A stale summary must not override the current saved review status');
assert.equal(audit([{...record([paper],[saved]),status:'match'}],
  [live('2617001','2026-11-03',[line('DAR00005',80)])],'2026-11-03')[0].state,'late',
  'The saved operator decision remains authoritative while numeric differences stay in details');
const approvedWithoutSource=audit([missingAmounts],[],'2026-11-03')[0];
assert.equal(approvedWithoutSource.state,'match');
assert.deepEqual(approvedWithoutSource.postedDates,[],
  'Saved approval alone must not invent an SAP posting date');
const approvedCanceled=audit([missingAmounts],
  [live('2617001','2026-11-03',[line('DAR00005',100)],{cancellationState:'canceled'})],'2026-11-03')[0];
assert.equal(approvedCanceled.state,'match');
assert.deepEqual(approvedCanceled.postedDates,[],
  'Canceled SAP documents must not supply an effective receipt date');
assert.deepEqual(JSON.parse(group.payload).invoices,[paper,paper2],
  'Read-only audit must not mutate previously saved invoices');

// The saved approval remains financial only; selected SAP cutoff must be
// independently checked even for the old 01/11 invoices.
assert.equal(notYetPosted.sapStatus,'waiting',
  'A 03/11 SAP posting must not be certified when cutoff is 02/11');
assert.equal(approvedWithoutSource.sapStatus,'review',
  'A missing SAP source cannot be certified based on financial approval');
const extendedSource=live('2617999','2026-11-08',[line('CHS00033',1)]);
const approvedFromNov1={...missingAmounts};
const reverseOnNov6=live('2617015','2026-11-06',[
  line('DAR00005',100,'Piece','011','001'),
],{reverse:true});
reverseOnNov6.remarks='عكس ترحيل 2617001';
const beforeNov6=audit([approvedFromNov1],[src,reverseOnNov6,extendedSource],'2026-11-05')[0];
assert.equal(beforeNov6.sapStatus,'posted',
  'A future reverse must not undo the original receipt before its SAP date');
const afterNov6=audit([approvedFromNov1],[src,reverseOnNov6,extendedSource],'2026-11-08')[0];
assert.equal(afterNov6.financiallyMatchedGroup,true);
assert.equal(afterNov6.sapStatus,'reversed',
  'The November 8 SAP check must catch a valid November 6 reverse');
assert.ok(afterNov6.notes.some(note=>note.includes('2617015')),
  'Show actual later reverse transfer number instead of hiding its evidence');
const noTransferSaved={...record([paper],[]),status:'match'};
const unlinkedInvoice=audit([noTransferSaved],[src,extendedSource],'2026-11-08')[0];
assert.equal(unlinkedInvoice.state,'match');
assert.equal(unlinkedInvoice.sapStatus,'missing',
  'Approved invoices with no proven transfer must never show a green SAP verification');
const explicitlyExtra=live('2617022','2026-11-07',[line('DAR00005',5)]);
explicitlyExtra.invoiceNumbers=['2631000001'];
const laterExplicitlyLinked=audit([approvedFromNov1],[src,explicitlyExtra,extendedSource],
  '2026-11-08')[0];
assert.equal(laterExplicitlyLinked.sapStatus,'review',
  'Later SAP movement mentioning this invoice must be disclosed, not silently assigned');
assert.ok(laterExplicitlyLinked.notes.some(note=>note.includes('2617022')));

// Cash Van movements are not missing blue invoices. A pair of independently
// posted partial reversals must settle only when every item/UoM/warehouse sums.
const cashOriginal=live('2615768','2026-11-02',[
  line('DAR00005',12),line('CHS00033',8),
]);
cashOriginal.remarks='Cash Van — عجلون';
cashOriginal.branch='12 — عجلون';
const cashReverse1=live('2615901','2026-11-03',[
  line('DAR00005',7,'Piece','011','001'),
  line('CHS00033',3,'Piece','011','001'),
],{reverse:true});
cashReverse1.remarks='عكس ترحيل 2615768';
cashReverse1.branch='12 — عجلون';
const cashReverse2=live('2615902','2026-11-03',[
  line('DAR00005',5,'Piece','011','001'),
  line('CHS00033',5,'Piece','011','001'),
],{reverse:true});
cashReverse2.remarks='عكس ترحيل 2615768';
cashReverse2.branch='12 — عجلون';
const cashInvoice=savedInvoice('cash-i','', '2026-11-01',0);
const cashRecord=record([cashInvoice],[card('2615768','2026-11-02',
  line('DAR00005',12),line('CHS00033',8))]);
const cashSettled=audit([cashRecord],[cashOriginal,cashReverse1,cashReverse2],
  '2026-11-03')[0];
assert.equal(cashSettled.state,'cashvan-settled',
  'Two exact partial reversals settle Cash Van without requiring a blue invoice');
assert.deepEqual(cashSettled.reverseNumbers,['2615901','2615902']);
assert.equal(cashSettled.items.length,0,
  'Cash Van must not fabricate a blue invoice item or quantity variance');
const cashBefore=audit([cashRecord],[cashOriginal,cashReverse1,cashReverse2],
  '2026-11-02')[0];
assert.equal(cashBefore.state,'cashvan-pending',
  'Reverse documents posted after cutoff must not backdate settlement');
assert.deepEqual(cashBefore.reverseNumbers,['2615901','2615902']);
const cashPartial=audit([cashRecord],[cashOriginal,cashReverse1],
  '2026-11-03')[0];
assert.equal(cashPartial.state,'cashvan-pending',
  'A referenced partial reverse alone does not prove zero stock');
assert.deepEqual(cashPartial.reverseNumbers,['2615901'],
  'Show the real partial reverse number even when settlement is incomplete');
const cashWrong=live('2615903','2026-11-03',[
  line('DAR00005',5,'Carton','011','001'),
  line('CHS00033',5,'Piece','011','001'),
],{reverse:true});
cashWrong.remarks='عكس ترحيل 2615768';
cashWrong.branch='12 — عجلون';
assert.equal(audit([cashRecord],[cashOriginal,cashReverse1,cashWrong],
  '2026-11-03')[0].state,'cashvan-pending',
  'Wrong UoM must never close a Cash Van document');
const missingCash=audit([cashRecord],[cashReverse1,cashReverse2],
  '2026-11-03')[0];
assert.equal(missingCash.state,'review',
  'Without the original SAP document, no reversal may be assumed to settle it');

const endpoint=fs.readFileSync('app/api/reconcile/route.ts','utf8');
assert.ok(endpoint.includes("u.searchParams.has('lieutenantInvoiceDay')"));
assert.ok(endpoint.includes('collectInvoicesByDate(records.results,day,day)'));
const screen=fs.readFileSync('app/reconciliation/FirstLieutenant.tsx','utf8');
assert.ok(screen.includes('فحص جميع فواتير هذا اليوم'));
assert.ok(screen.includes('auditInvoicesForDay(dailyInvoices,transfers,invoiceAsOf,reference)'));
assert.ok(!screen.includes('معتمدة ماليًا فقط'));
assert.ok(screen.includes('dailyCounts.match+dailyCounts.late'));
assert.ok(screen.includes('رقم الترحيل العكسي:'));
assert.ok(screen.includes('كاش فان مسوّى'));
console.log('PASS: Saved operator approval, unapproved quantity checks, SAP cutoff, delay, cancellation, shared quantities and no-write safeguards.');
