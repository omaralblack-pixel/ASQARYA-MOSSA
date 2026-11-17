import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const compile=source=>ts.transpileModule(source,{compilerOptions:{
 target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},fileName:'colonel-core.ts'}).outputText;
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const rec=url(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const invoice=url(compile(fs.readFileSync('app/lib/invoice-collector.ts','utf8')
 .replace("'./reconcile'","'"+rec+"'")));
const movements=url(compile(fs.readFileSync('app/lib/lieutenant-counterparts.ts','utf8')));
const source=fs.readFileSync('app/lib/colonel-core.ts','utf8')
 .replace("'./reconcile'","'"+rec+"'")
 .replace("'./invoice-collector'","'"+invoice+"'")
 .replace("'./lieutenant-counterparts'","'"+movements+"'");
const {buildColonelReport}=await import(url(compile(source)));
const noteSource=fs.readFileSync('app/lib/colonel-serial-notes.ts','utf8')
 .replace("'./lieutenant-counterparts'","'"+movements+"'");
const {colonelSerialNotes}=await import(url(compile(noteSource)));
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const paste=(code,from='001',to='011')=>header+'\n'+code+'\tItem\t1\tPiece\t'+from+'\t'+to;
const invoiceRow=(number,date)=>({number,date,amount:'250.000',complete:true});
const record=(id,invoiceRows,ids)=>({id,branch:'1 — الكرامة',status:'match',
 updated:'2026-11-17T07:00:00.000Z',
 payload:JSON.stringify({branch:'1 — الكرامة',invoices:invoiceRows,
 transfers:ids.map(number=>({number,date:'2026-11-05',paste:paste('DAR00001')}))})});
const sapRow=(number,date,other={})=>({
 transfer:{number,date,paste:paste('DAR00001')},branch:'1 — الكرامة',
 remarks:'',lineCount:1,reverse:false,cancellationState:'active',
 cancellationMentioned:false,signedAdjustment:false,issues:[],invoiceNumbers:[],...other
});
const saved=[record('g3',[invoiceRow('2621609885','2026-11-03'),invoiceRow('2621609886','2026-11-03')],['2615774'])];
const sap=[sapRow('2615774','2026-11-05'),
 sapRow('2619999','2026-11-03',{invoiceNumbers:['2621609885']}),
 sapRow('2618888','2026-11-03'),
 sapRow('2617777','2026-11-03',{cancellationState:'canceled'})];
const day=[{day:'2026-11-03',invoices_complete:1,confirmed_at:'2026-11-17T07:00:00Z',confirmed_by:'operator'}];
let result=buildColonelReport('2026-11',saved,sap,[],[],day,true);
const three=result.days.find(x=>x.day==='2026-11-03');
assert.equal(three.invoices.length,2,'Both invoices use their PAPER date, never SAP posting date');
assert.equal(result.days.find(x=>x.day==='2026-11-05').invoices.length,0);
assert.deepEqual(three.transfers.map(x=>x.number).sort(),['2615774','2619999'].sort());
assert.equal(three.transfers.find(x=>x.number==='2615774').postingDate,'2026-11-05',
 'Original SAP posting date remains available for stock and late posting');
assert.equal(three.transfers.find(x=>x.number==='2619999').needsAction,true,
 'Posted SAP transfer mentioned in invoice Remarks but not saved in project needs an action');
assert.equal(three.ready,false,'Days with unlinked SAP postings are not ready');
assert.ok(result.unassigned.some(x=>x.number==='2618888'&&x.needsAction),
 'A transfer without a proven blue-invoice day remains unassigned');
assert.ok(result.unassigned.some(x=>x.number==='2617777'&&!x.needsAction),
 'Canceled SAP transfers cannot be treated as missing invoices');
const assigned=[{transfer_no:'2618888',invoice_day:'2026-11-02',
 reason:'رقم فاتورة الورق المؤكد',updated_at:'2026-11-17'}];
result=buildColonelReport('2026-11',saved,sap,[],assigned,day,true);
assert.ok(result.days.find(x=>x.day==='2026-11-02').transfers.some(x=>x.number==='2618888'),
 'Manual business-day attribution is explicit and stored separately');
assert.ok(result.days.find(x=>x.day==='2026-11-02').invoices.length===0,
 'Manual day assignment never invents a blue invoice');
const decision=[{transfer_no:'2618888',decision:'linked',related_type:'transfer',
 related_number:'2617777',note:'تحت المراجعة',revision:1,updated_at:'2026-11-17'}];
result=buildColonelReport('2026-11',saved,sap,decision,assigned,day,true);
assert.ok(result.days.find(x=>x.day==='2026-11-02').transfers[0].needsAction,
 'Manual lieutenant decision is NOT proof of SAP cancellation');
assert.ok(!result.days.find(x=>x.day==='2026-11-02').transfers[0].note.includes('ملغى رسميًا'),
 'Administrative link must not misrepresent SAP cancellation state');
const untrusted=buildColonelReport('2026-11',saved,[sap[0]],[],[],day,false);
assert.equal(untrusted.days.find(x=>x.day==='2026-11-03').ready,false,
 'Incomplete SAP coverage cannot certify a day');
const missingDate=record('missing-date',[invoiceRow('2621609887','')],['2616666']);
const inferred=buildColonelReport('2026-11',[missingDate],[sapRow('2616666','2026-11-05')],[],[],day,true);
assert.ok(inferred.days.find(x=>x.day==='2026-11-04').invoices.some(x=>x.dateSource==='transfer'));
assert.equal(inferred.days.find(x=>x.day==='2026-11-04').ready,false,
 'Inferred invoice date cannot be treated as confirmed paper date');

const manualBypass=[{transfer_no:'2618888',decision:'ignore',related_type:'',
 related_number:'',note:'تمت مراجعة هذا الترحيل وتجاوزه إداريًا',revision:2,updated_at:'2026-11-17'}];
result=buildColonelReport('2026-11',saved,sap,manualBypass,[],day,true);
assert.ok(result.unassigned.some(x=>x.number==='2618888'&&!x.needsAction));
assert.ok(!result.unassigned.find(x=>x.number==='2618888').note.includes('ملغى رسميًا'),
 'Operator exception must never masquerade as SAP cancellation');
const notes=colonelSerialNotes([
 sapRow('2617777','2026-11-03',{cancellationState:'canceled'}),
 sapRow('2618888','2026-11-03'),
 ],manualBypass,'2026-11-17');
assert.match(notes.get('2617777'),/ملغى رسميًا على SAP/);
assert.match(notes.get('2618888'),/تجاوز إداري فقط/);
assert.doesNotMatch(notes.get('2618888'),/ملغى رسميًا/);
const archivedDecision=colonelSerialNotes([],manualBypass,'2026-11-17');
assert.match(archivedDecision.get('2618888'),/حالة SAP غير مثبتة/);
assert.throws(()=>buildColonelReport('2026-13',[],[]),/شهر/);
console.log('PASS: Colonel uses blue-invoice date, preserves SAP posting, flags mismatches and does not assert fake cancellations.');
