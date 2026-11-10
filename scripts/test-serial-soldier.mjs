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
assert.ok(result.blockers.some(e=>e.includes('لا يمكن ربط')),'Old missing pages still blocked by default');
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[legacyRecord],{allowLegacyPageGaps:true});
assert.deepEqual(result.blockers,[],'Explicit historical page exception permits audit export only');
assert.equal(result.legacyWarnings.length,4);
assert.deepEqual(result.rows.map(r=>r.transfers),[[],[]],'Uncertain transfers must not be attributed to invoices');
assert.deepEqual(result.rows.map(r=>r.unassignedTransfers.map(t=>t.number)),
 [['2612001','2612002'],['2612001','2612002']],'No old group transfer can be silently omitted');
const newRecord=record('g-future',[
 {...invoice('2624002303','186.400'),date:'2026-11-10'},
 {...invoice('2624002304','591.160'),date:'2026-11-10'}
],[transfer('2612001','DAR00001','001','011')]);
result=evaluateSerial([row(5,'2624002303','186.400')],[newRecord],{allowLegacyPageGaps:true});
assert.ok(result.blockers.some(e=>e.includes('لا يمكن ربط')),'Future groups cannot use historical exception');
result=evaluateSerial([row(5,'2624002303','186.401')],[legacyRecord],{allowLegacyPageGaps:true});
assert.equal(result.rows[0].state,'review','Historical override cannot approve amount discrepancy');
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002303','186.400')],[legacyRecord],{allowLegacyPageGaps:true});
assert.ok(result.blockers.some(e=>e.includes('مكرر')),'Historical override cannot bypass duplicate invoice protections');
console.log('PASS: invoice serial soldier verifies money, receipt, grouping and one-export exception for historical page gaps only');
