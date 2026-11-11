import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const rec=url(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const source=fs.readFileSync('app/lib/serial-soldier.ts','utf8').replace("'./reconcile'","'"+rec+"'");
const {evaluateSerial,serialColumns}=await import(url(compile(source)));
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
assert.equal(result.rows[0].state,'review','Difference of 1 fils must not become green');
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400',false)],base)]);
assert.equal(result.rows[0].state,'pending','Unchecked paper must stay pink');
result=evaluateSerial([row(5,'9999999999','1.000')],[correct]);
assert.equal(result.rows[0].state,'missing');
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400')],base,{summary:{status:'review'}})]);
assert.equal(result.rows[0].state,'review','Unapproved reconciliation cannot be received');
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
const unapprovedOld=record('g-old-review',[
 {...invoice('2624002303','186.400'),date:'2026-11-09'},
 {...invoice('2624002304','591.160'),date:'2026-11-09'}
],[transfer('2612001','DAR00001','001','011')],{summary:{status:'review'}});
assert.ok(evaluateSerial([row(5,'2624002303','186.400')],[unapprovedOld]).blockers
 .some(e=>e.includes('لا يمكن ربط')),
 'Only already MATCH records receive historical exception');
assert.equal(evaluateSerial([row(5,'2624002303','186.401')],[legacyRecord]).rows[0].state,'review',
 'One-fils mismatch in Saja still requires review');
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
assert.equal(result.rows[0].state,'review');
const guessedSaja={...row(5,'2660506908','186.400'),originalTransfers:['2611001']};
result=evaluateSerial([guessedSaja],[correct]);
assert.equal(result.rows[0].state,'review','A number discrepancy must never become green');
assert.equal(result.rows[0].number,'2660506908','Preserve the original Saja guess');
assert.equal(result.rows[0].omarNumber,'2624002303','Show Omar official invoice number via unique transfer');
assert.ok(result.rows[0].reason.includes('اختلاف رقم الفاتورة'));
const second=record('another',[invoice('2629999999','12.000')],[transfer('2611001','DAR00001','001','011')]);
result=evaluateSerial([guessedSaja],[correct,second]);
assert.equal(result.rows[0].state,'missing','Ambiguous transfer ownership must not guess Omar invoice');
assert.equal(result.rows[0].omarNumber,'');
assert.ok(evaluateSerial([row(5,'2624002303','186.400')],[record('broken',[invoice('2624002303','186.400')],[])])
 .rows[0].state==='review','No verified transfers must not produce a green invoice');
console.log('PASS: Omar/Saja numbers and amounts are preserved side by side; uncertain links remain unresolved');
console.log('PASS: serial soldier retains approved old group matching without page numbers, while enforcing amount, duplicates and new records');
