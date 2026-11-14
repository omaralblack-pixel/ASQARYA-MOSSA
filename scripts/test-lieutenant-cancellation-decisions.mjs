import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';

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
const {cancellationReviewRows,validateCancellationDecision}=
  loadTs('app/lib/lieutenant-cancellation-decisions.ts');
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
function transfer(number,date,from,to,cancellationState='active',remarks='',cancellationMentioned=false){
  return {transfer:{id:number,number,date,paste:header+'\n'+[
    'DAR00005','Sample',12,'Piece',from,to,
  ].join('\t')},branch:'12 — عجلون',remarks,reverse:from==='011',
  cancellationState,cancellationMentioned,signedAdjustment:false,
  lineCount:1,issues:[],invoiceNumbers:[]};
}
const unmatched=transfer('2619101','2026-11-02','001','011','canceled');
const original=transfer('2619102','2026-11-03','001','011','canceled');
const cancellation=transfer('2619103','2026-11-04','011','001','cancellation',
  'Inventory transfer no. 2619102 has been canceled',true);
const hinted=transfer('2619104','2026-11-05','001','011','unknown',
  'Needs cancellation review',true);
const ordinary=transfer('2619105','2026-11-05','001','011');
const future=transfer('2619106','2026-11-12','001','011','canceled');
const source=[unmatched,original,cancellation,hinted,ordinary,future];
const rows=cancellationReviewRows(source,'2026-11-01','2026-11-10');
assert.deepEqual(rows.map(row=>row.source.transfer.number),
  ['2619101','2619102','2619103','2619104']);
assert.equal(rows[0].proven,false,'CANCELED=Y alone does not establish a reason or counterpart');
assert.match(rows[0].automaticReason,/غير مثبت/);
assert.equal(rows[1].proven,true,'An exact, dated SAP cancellation document proves a counterpart');
assert.deepEqual(rows[1].counterparts,['2619103']);
assert.equal(rows[2].proven,true,'Both sides of a validated cancellation pair are visible');
assert.equal(rows[3].proven,false,'A Remarks hint alone must not be displayed as verified SAP cancellation');
assert.equal(cancellationReviewRows(source,'2026-11-12','2026-11-12').length,1,
  'Date filtering is by SAP document date');
assert.equal(cancellationReviewRows(source,'2026-11-01','2026-11-10').length,4,
  'Read-only candidate selection must be stable across repeated reports');
const input=(decision,relatedType='',relatedNumber='',note='')=>({
  transferNo:'2619101',decision,relatedType,relatedNumber,note,
});
assert.equal(validateCancellationDecision(input('ignore','','','تمام')).value?.decision,'ignore');
assert.equal(validateCancellationDecision(input('linked','transfer','2619102')).value?.relatedNumber,'2619102');
assert.equal(validateCancellationDecision(input('linked','invoice','2630806229')).value?.relatedType,'invoice');
assert.equal(validateCancellationDecision(input('linked','other','تسوية يدوية')).value?.relatedNumber,'تسوية يدوية');
assert.equal(validateCancellationDecision(input('keep','invoice','2630806229')).value?.decision,'keep');
assert.ok(validateCancellationDecision(input('keep','invoice','')).error,
  'Do-not-cancel review requires its blue invoice number');
assert.ok(validateCancellationDecision(input('keep','transfer','2619102')).error);
assert.ok(validateCancellationDecision(input('linked','transfer','2619101')).error,
  'A transfer may not reference itself');
assert.ok(validateCancellationDecision(input('linked','invoice','abc')).error);
assert.ok(validateCancellationDecision(input('ignore','invoice','2630806229')).error);
assert.ok(validateCancellationDecision(input('ignore','','','x'.repeat(601))).error);
assert.ok(validateCancellationDecision({...input('ignore'),transferNo:'x'}).error);
const route=fs.readFileSync('app/api/reconcile/route.ts','utf8');
assert.ok(route.includes("u.searchParams.has('lieutenantCancellationDecisions')"));
assert.ok(route.includes("b.action==='lieutenantCancellationDecision'"));
assert.ok(route.includes("revision=revision+1"),'Each update must prevent stale writes');
assert.ok(route.includes('revision=?'), 'Deleting or updating requires the prior revision');
assert.ok(!route.split("b.action==='lieutenantCancellationDecision'")[1].split("if(b.action==='reference'")[0]
  .includes('UPDATE reconciliations'), 'Cancellation review may not change financial approvals');
const schema=JSON.parse(fs.readFileSync('app/lib/reconciliation-schema.json','utf8'));
assert.ok(schema.some(query=>query.includes('CREATE TABLE IF NOT EXISTS lieutenant_cancellation_decisions')));
const screen=fs.readFileSync('app/reconciliation/CancelledTransferReview.tsx','utf8');
assert.ok(screen.includes('حفظ القرار دائمًا'));
assert.ok(screen.includes('إعادة فتح للمراجعة'));
assert.ok(screen.includes('onOpenTransfer'));
assert.ok(screen.includes("className=\"no-print\""));
assert.ok(screen.includes('saved.updated_at') && screen.includes('saved.note'),
  'Saved annotation must be visible and printable, not only in the edit form');
assert.ok(fs.readFileSync('app/reconciliation/FirstLieutenant.tsx','utf8')
  .includes('<CancelledTransferReview transfers={transfers} from={from} to={to}'));
console.log('PASS: Unexplained SAP cancellations, exact counterparts, date filters, manual decisions, invoice refs, revision-safe persistence and printable notes.');
