import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const rec=url(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const source=fs.readFileSync('app/lib/serial-soldier.ts','utf8').replace("'./reconcile'","'"+rec+"'");
const {evaluateSerial,serialColumns,serialReviewNote,serialInvoiceColumns}=await import(url(compile(source)));
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const paste=(code,from,to)=>header+'\n'+code+'\tItem\t1\tPiece\t'+from+'\t'+to;
const invoice=(number,amount,complete=true)=>({number,amount,complete});
const transfer=(number,code,from,to)=>({number,paste:paste(code,from,to)});
const record=(id,invoices,transfers,extra={})=>({id,branch:'فرع تجريبي',payload:JSON.stringify({invoices,transfers,summary:{status:'match'},...extra})});
const row=(row,number,amount)=>({row,number,amount,date:'2026-11-09'});
const base=[
 transfer('2611001','DAR00001','001','011'),
 transfer('2611002','DAR00002','002','011'),
 transfer('2611003','DAR00003','009','011'),
 transfer('2611004','DAR00004','011','001'),
];
const correct=record('g1',[invoice('2624002303','186.400')],base);
let result=evaluateSerial([row(5,'2624002303','186.4')],[correct]);
assert.deepEqual(result.count,{received:1,pending:0,missing:0,review:0});
assert.deepEqual(result.blockers,[]);
assert.deepEqual(serialColumns(result.rows[0].transfers),['2611001','2611002','2611003','2611004']);
result=evaluateSerial([row(5,'2624002303','186.401')],[correct]);
assert.equal(result.rows[0].state,'received_difference','One-fils discrepancy is received but stays yellow');
assert.equal(result.count.received,1,'A received invoice with a difference belongs in received total');
assert.equal(result.count.review,0,'Amount difference alone must not count as unreceived/review');
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400',false)],base)]);
assert.equal(result.rows[0].state,'pending','Unchecked paper must stay pink');
result=evaluateSerial([row(5,'2624002303','186.401')],[record('g1',[invoice('2624002303','186.400',false)],base)]);
assert.equal(result.rows[0].state,'pending','Amount difference must never conceal unconfirmed paper');
assert.ok(serialReviewNote(result.rows[0]).includes('ورق الفاتورة غير مؤكد'));
result=evaluateSerial([row(5,'9999999999','1.000')],[correct]);
assert.equal(result.rows[0].state,'missing');
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400')],base,{summary:{status:'review'}})]);
assert.equal(result.rows[0].state,'review','Unapproved reconciliation cannot be received');
result=evaluateSerial([row(5,'2624002303','186.401')],[record('g1',[invoice('2624002303','186.400')],base,{summary:{status:'review'}})]);
assert.equal(result.rows[0].state,'review','Discrepancy does not override an unapproved reconciliation');
assert.ok(serialReviewNote(result.rows[0]).includes('المطابقة المحفوظة غير معتمدة'));
result=evaluateSerial([row(5,'2624002303','186.400'),row(7,'2624002303','186.400')],[correct]);
assert.ok(result.blockers.some(e=>e.includes('مكرر')));
result=evaluateSerial([row(5,'2624002303','186.400')],[correct,record('g2',[invoice('2624002303','186.400')],base)]);
assert.ok(result.blockers.some(e=>e.includes('مكرر')));
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400')],[{number:'2611001',paste:header+'\nDAR00001\tA\t1\tPiece\t001\t011\nDAR00002\tB\t1\tPiece\t002\t011'}])]);
assert.deepEqual(result.blockers,[],'Multiple valid directions in a single SAP transfer are not an error');
assert.equal(result.rows[0].transfers[0].kind,'adjustment','Mixed transfer is listed as adjustment, not falsely main or dry');
const refs=[{code:'11001',sapCode:'DAR00001',active:true},{code:'11002',sapCode:'DAR00002',active:true}];
const group=record('g-multi',[invoice('2624002303','186.400'),invoice('2624002304','591.160')],[transfer('2612001','DAR00001','001','011'),transfer('2612002','DAR00002','002','011')],{
  referenceSnapshot:refs,pages:{'i:11001':'1','i:11002':'2'}
});
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[group]);
assert.deepEqual(result.blockers,[]);
assert.deepEqual(result.rows.map(x=>x.transfers.map(t=>t.number)),[['2612001'],['2612002']],'No transfer may leak between invoices');
const ambiguous=record('g-multi',[invoice('2624002303','186.400'),invoice('2624002304','591.160')],[transfer('2612001','DAR00001','001','011')]);
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[ambiguous]);
assert.ok(result.blockers.some(e=>e.includes('لا يمكن ربط')));
const legacyRecord=record('g-legacy',[
 {...invoice('2624002303','186.400'),date:'2026-11-09'},
 {...invoice('2624002304','591.160'),date:'2026-11-09'}
],[transfer('2612001','DAR00001','001','011'),transfer('2612002','DAR00002','002','011')]);
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[legacyRecord]);
assert.deepEqual(result.blockers,[],'Approved historical group may export without saved page numbers');
assert.equal(result.count.received,2,'Both old MATCH invoices must remain received');
assert.deepEqual(result.rows.map(r=>r.unassignedTransfers.map(t=>t.number)),
 [['2612001','2612002'],['2612001','2612002']],
 'Group-certified transfers must not be falsely assigned to individual invoice pages');
assert.equal(result.rows.every(r=>r.reason.includes('مؤكدان')),true);
assert.equal(result.legacyWarnings.length,4);
// Regression: Gardenz invoices 2624002303/04 were previously blank in Saja K:Q
// because approved historical group transfers were retained separately.
assert.deepEqual(result.rows.map(r=>serialInvoiceColumns(r)),
 [['2612001','2612002'],['2612001','2612002']],
 'Both Saja invoice rows must list approved historical group transfer numbers');
assert.deepEqual(result.rows.map(r=>r.transfers),[[],[]],
 'The export must not fabricate saved invoice-page ownership');
// If a transfer is independently allocated and a different approved transfer is
// group-level, show both once with their correct main/dry warehouse columns.
assert.deepEqual(serialInvoiceColumns({
 transfers:[{number:'2615908',kind:'main'}],
 unassignedTransfers:[{number:'2615908',kind:'main'},{number:'2615826',kind:'dry'}],
}),['2615908','2615826'],'Keep existing main and shared dry numbers without duplicating them');
const fallbackApproved=record('fallback',[
 {...invoice('2624002303','186.400'),date:'2026-11-09'},
 {...invoice('2624002304','591.160'),date:'2026-11-09'}
],[transfer('2612001','DAR00001','001','011')],{summary:undefined});
fallbackApproved.status='match';
const fallbackReport=evaluateSerial([row(5,'2624002303','186.400')],[fallbackApproved]);
assert.deepEqual(fallbackReport.blockers,[],
 'Old records with a MATCH database status but no embedded summary are still approved');
assert.equal(fallbackReport.rows[0].state,'received');

const oldNov10=record('g-10',[
 {...invoice('2624002303','186.400'),date:'2026-11-10'},
 {...invoice('2624002304','591.160'),date:'2026-11-10'}
],[transfer('2612001','DAR00001','001','011'),transfer('2612002','DAR00002','002','011')]);
assert.deepEqual(evaluateSerial([row(5,'2624002303','186.400')],[oldNov10]).blockers,[],
 'November 10 belongs to historic records before cutoff');
const newRecord=record('g-new',[
 {...invoice('2624002303','186.400'),date:'2026-11-11'},
 {...invoice('2624002304','591.160'),date:'2026-11-11'}
],[transfer('2612001','DAR00001','001','011')]);
assert.ok(evaluateSerial([row(5,'2624002303','186.400')],[newRecord]).blockers
 .some(e=>e.includes('لا يمكن ربط')),
 'New invoices still require their page allocations');
const newResult=evaluateSerial([row(5,'2624002303','186.400')],[newRecord]);
assert.deepEqual(serialInvoiceColumns(newResult.rows[0]),['2612001',''],
 'Newer groups without invoice-page allocations still display saved group transfer number');
assert.equal(newResult.rows[0].state,'review',
 'Showing a shared group transfer must not falsely approve a new unallocated invoice');
// Actual Gardenz pattern: two already approved invoices in one group with no
// individual page allocations still need both of the group's transfer numbers.
const gardenz=record('garden',[
 {...invoice('2624002303','186.400'),date:'2026-11-01'},
 {...invoice('2624002304','591.160'),date:'2026-11-01'},
],[transfer('2615824','DAR00001','001','011'),transfer('2615907','DAR00002','002','011')]);
const gardenzReport=evaluateSerial([
 row(5,'2624002303','186.400'),row(6,'2624002304','591.160'),
],[gardenz]);
assert.deepEqual(gardenzReport.rows.map(serialInvoiceColumns),
 [['2615824','2615907'],['2615824','2615907']],
 'Never leave historical Gardenz invoices blank when saved group transfers are known');
assert.deepEqual(gardenzReport.count,{received:2,pending:0,missing:0,review:0});
// Historical Al-Eis pattern: three confirmed 01-Nov invoices share two
// transfers, but one invoice page has zero directly assigned item rows.
// Group transfers must be visible without fabricating page-specific ownership.
const aisOld=record('ais-old',[
 {...invoice('2660506906','241.800'),date:'2026-11-01'},
 {...invoice('2660506907','1238.780'),date:'2026-11-01'},
 {...invoice('2660506908','801.850'),date:'2026-11-01'},
],[
 transfer('2615820','DAR00001','001','011'),
 transfer('2615821','DAR00002','002','011'),
],{pages:{'s:DAR00001':'1','s:DAR00002':'2'}});
const aisResult=evaluateSerial([
 row(14,'2660506906','241.800'),row(15,'2660506907','1238.780'),row(16,'2660506908','801.850'),
],[aisOld]);
assert.equal(aisResult.blockers.length,0,
 'An approved old invoice with no assigned item rows must not be reported as transferless');
assert.deepEqual(aisResult.count,{received:3,pending:0,missing:0,review:0});
assert.deepEqual(aisResult.rows[2].transfers,[],
 'Page 3 must not receive invented page-specific transfer ownership');
assert.deepEqual(serialInvoiceColumns(aisResult.rows[2]),['2615820','2615821'],
 'Page 3 may list the approved group transfers as group-level associations');
const aisNew=record('ais-new',[
 {...invoice('2660506906','241.800'),date:'2026-11-12'},
 {...invoice('2660506907','1238.780'),date:'2026-11-12'},
 {...invoice('2660506908','801.850'),date:'2026-11-12'},
],[
 transfer('2615820','DAR00001','001','011'),
 transfer('2615821','DAR00002','002','011'),
],{pages:{'s:DAR00001':'1','s:DAR00002':'2'}});
assert.equal(evaluateSerial([
 row(14,'2660506906','241.800'),row(15,'2660506907','1238.780'),row(16,'2660506908','801.850')
],[aisNew]).rows[2].state,'review',
 'The old-group exception must never silently approve a new invoice without page evidence');

const unapprovedOld=record('g-old-review',[
 {...invoice('2624002303','186.400'),date:'2026-11-09'},
 {...invoice('2624002304','591.160'),date:'2026-11-09'}
],[transfer('2612001','DAR00001','001','011')],{summary:{status:'review'}});
assert.ok(evaluateSerial([row(5,'2624002303','186.400')],[unapprovedOld]).blockers
 .some(e=>e.includes('لا يمكن ربط')),
 'Only already MATCH records receive historical exception');
assert.equal(evaluateSerial([row(5,'2624002303','186.401')],[legacyRecord]).rows[0].state,'received_difference',
 'One-fils mismatch in an approved legacy invoice is received with a yellow remark');
assert.ok(evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002303','186.400')],[legacyRecord]).blockers
 .some(e=>e.includes('مكرر')),
 'Invoice duplicates remain critical errors');
assert.deepEqual(evaluateSerial([row(5,'2624002303','186.400')],[record('other',[
 {...invoice('2624002303','186.400'),date:'2026-11-09'}
],[transfer('2611004','DAR00004','011','001')])]).blockers,[],
 'Valid one-invoice historical records remain supported');
// Omar's saved figures stay authoritative, while Saja's original cells are kept for comparison.
result=evaluateSerial([row(5,'2624002303','186.401')],[correct]);
assert.equal(result.rows[0].omarNumber,'2624002303');
assert.equal(result.rows[0].omarAmount,'186.400');
assert.equal(result.rows[0].amount,'186.401');
assert.equal(result.rows[0].state,'received_difference');
assert.equal(result.count.received,1);
const guessedSaja={...row(5,'2660506908','186.400'),originalTransfers:['2611001']};
result=evaluateSerial([guessedSaja],[correct]);
assert.equal(result.rows[0].state,'received_difference','A uniquely transfer-linked number discrepancy is received in yellow');
assert.equal(result.count.received,1,'Unique SAP transfer evidence counts a paper-confirmed invoice as received');
assert.equal(result.rows[0].number,'2660506908','Preserve the original Saja guess');
assert.equal(result.rows[0].omarNumber,'2624002303','Show Omar official invoice number via unique transfer');
assert.ok(serialReviewNote(result.rows[0]).includes('فرق رقم الفاتورة'));
const second=record('another',[invoice('2629999999','12.000')],[transfer('2611001','DAR00001','001','011')]);
result=evaluateSerial([guessedSaja],[correct,second]);
assert.equal(result.rows[0].state,'missing','Ambiguous transfer ownership must not guess Omar invoice');
assert.equal(result.rows[0].omarNumber,'');
assert.ok(evaluateSerial([row(5,'2624002303','186.400')],[record('broken',[invoice('2624002303','186.400')],[])])
 .rows[0].state==='review','No verified transfers must not produce a green invoice');
const clean=evaluateSerial([row(5,'2624002303','186.400')],[correct]).rows[0];
assert.equal(serialReviewNote(clean),'','Matched invoices must not clutter the sheet with duplicate values');
const amountMismatch=evaluateSerial([row(5,'2624002303','186.401')],[correct]).rows[0];
assert.equal(serialReviewNote(amountMismatch),'فرق المبلغ: عمر 186.400 د.أ، سجى 186.401 د.أ');
const wrongNumber=evaluateSerial([guessedSaja],[correct]).rows[0];
assert.equal(serialReviewNote(wrongNumber),'فرق رقم الفاتورة: عمر 2624002303، سجى 2660506908');
const bothWrong=evaluateSerial([{...guessedSaja,amount:'186.420'}],[correct]).rows[0];
assert.ok(serialReviewNote(bothWrong).includes('فرق رقم الفاتورة: عمر'));
assert.ok(serialReviewNote(bothWrong).includes('فرق المبلغ: عمر 186.400'));
assert.equal(bothWrong.state,'received_difference','Both discrepancies remain one received yellow invoice');
assert.equal(evaluateSerial([{...guessedSaja,amount:'186.420'}],[correct]).count.received,1);
assert.equal(serialReviewNote(evaluateSerial([row(5,'9999999999','2.000')],[correct]).rows[0]),'غير موجودة في سجل المطابقة؛ لا يمكن استنتاج وصول الورق من غياب التسجيل');
console.log('PASS: only exception rows receive concise Omar-vs-Saja notes, including three-decimal amounts');
console.log('PASS: confirmed arrival is counted despite amount/number differences while uncertain links remain unresolved');
console.log('PASS: serial soldier retains approved old group matching without page numbers, preserves discrepancy notes, and enforces uniqueness and pending states');
