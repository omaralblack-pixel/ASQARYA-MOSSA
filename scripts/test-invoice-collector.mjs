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
  const {outputText,diagnostics}=ts.transpileModule(fs.readFileSync(file,'utf8'),{
    fileName:file,
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    reportDiagnostics:true,
  });
  assert.deepEqual(diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error)||[],[]);
  new Function('exports','require',outputText)(exports,name=>{
    if(name.endsWith('.json'))return createRequire(file)(name);
    if(name.startsWith('.'))return loadTs(resolve(dirname(file),name+'.ts'));
    return createRequire(file)(name);
  });
  return exports;
}

const {collectInvoicesByDate}=loadTs('app/lib/invoice-collector.ts');
const {sortSoldierInvoicePages}=loadTs('app/lib/soldier-page-sort.ts');
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const transfer=(number,rows)=>({
  id:'t-'+number,number,date:'2026-11-02',
  paste:header+'\n'+rows.map(row=>row.join('\t')).join('\n'),
});
const inv=(id,number,date,amount,lines)=>({
  id,number,date,amount,complete:false,auditLines:lines,quantities:{},
});
const catalog={
  sap:[
    {code:'DAR00005',name:'cream',unit:'Carton',pack:20,kg:null,institutionCode:'11371486'},
    {code:'CHS00033',name:'cheese',unit:'Piece',pack:12,kg:null,institutionCode:'11064245'},
  ],
  institution:[
    {code:'11371486',name:'cream',price:1550},
    {code:'11064245',name:'cheese',price:800},
  ],
};
const first=transfer('2615774',[['DAR00005','cream','2','Carton','001','011']]);
const second=transfer('2615773',[['CHS00033','cheese','12','Piece','002','011']]);
const draft={
  id:'g1',branch:'23 — خالد',driver:'',date:'2026-11-02',
  transfers:[first,second],notes:'',
  invoices:[
    inv('i1','2610013337','2026-11-01','600.640','11371486\t40'),
    inv('i2','2610013338','2026-11-02','9.600','11064245\t12'),
  ],
};
const sorted=sortSoldierInvoicePages(draft,catalog);
assert.equal(sorted.unresolved.length,0);
assert.equal(sorted.assigned,2);
const rows=collectInvoicesByDate([{id:'r1',branch:draft.branch,payload:JSON.stringify(sorted.draft)}],
  '1.11.2026','2.11.2026');
assert.equal(rows.rows.length,2);
assert.equal(rows.days,2);
assert.deepEqual(rows.rows.map(row=>row.transferNumbers),[['2615774'],['2615773']]);
assert.equal(rows.rows[0].number,'2610013337');
assert.equal(rows.rows[0].branch,'23 — خالد');
assert.equal(rows.rows[0].date,'2026-11-01');
assert.equal(rows.rows[0].amount,'600.640','Keep exact three-decimal amount from record');
assert.equal(rows.rows[0].unresolvedTransferNumbers.length,0);

const onlyNov1=collectInvoicesByDate([{id:'r1',branch:draft.branch,payload:JSON.stringify(sorted.draft)}],
  '2026-11-01','2026-11-01');
assert.equal(onlyNov1.rows.length,1);

const unsafe=collectInvoicesByDate([{id:'r1',branch:draft.branch,payload:JSON.stringify(draft)}],
  '2026-11-01','2026-11-02');
assert.equal(unsafe.rows.length,2);
assert.deepEqual(unsafe.rows.map(row=>row.transferNumbers),[[],[]]);
assert.deepEqual(unsafe.rows.map(row=>row.unresolvedTransferNumbers),
  [['2615774','2615773'],['2615774','2615773']]);

// A user-approved old group is confirmed even when per-invoice page keys were never stored.
const oldApproved={...draft,summary:{status:'match'}};
const approvedRows=collectInvoicesByDate([{id:'approved',branch:draft.branch,payload:JSON.stringify(oldApproved)}],
  '2026-11-01','2026-11-02');
assert.deepEqual(approvedRows.rows.map(row=>row.unresolvedTransferNumbers),[[],[]]);
assert.deepEqual(approvedRows.rows.map(row=>row.groupConfirmedTransfers),
  [['2615774','2615773'],['2615774','2615773']]);
const approvedByStatus=collectInvoicesByDate([{id:'approved2',branch:draft.branch,status:'match',payload:JSON.stringify(draft)}],
  '2026-11-01','2026-11-02');
assert.deepEqual(approvedByStatus.rows.map(row=>row.groupConfirmedTransfers),
  [['2615774','2615773'],['2615774','2615773']]);
const oldRejected=collectInvoicesByDate([{id:'review',branch:draft.branch,status:'review',payload:JSON.stringify(draft)}],
  '2026-11-01','2026-11-02');
assert.deepEqual(oldRejected.rows.map(row=>row.groupConfirmedTransfers),[[],[]]);
assert.deepEqual(oldRejected.rows.map(row=>row.unresolvedTransferNumbers),
  [['2615774','2615773'],['2615774','2615773']]);

const oneInvoice={...draft,invoices:[draft.invoices[0]]};
const single=collectInvoicesByDate([{id:'one',branch:'23 — خالد',payload:JSON.stringify(oneInvoice)}],
  '2026-11-01','2026-11-01');
assert.deepEqual(single.rows[0].transferNumbers,['2615774','2615773']);

const damaged=collectInvoicesByDate([
  {id:'valid',branch:draft.branch,payload:JSON.stringify(draft)},
  {id:'bad',branch:'x',payload:'{broken'},
], '2026-11-01','2026-11-02');
assert.equal(damaged.unreadableRecords,1);
assert.equal(damaged.rows.length,2);
assert.throws(()=>collectInvoicesByDate([], '2026-11-03','2026-11-01'),/البداية/);
assert.throws(()=>collectInvoicesByDate([], 'not-date','2026-11-01'),/تاريخ/);
assert.throws(()=>collectInvoicesByDate([], '2025-01-01','2026-02-01'),/366/);

// Recover only dates that are grounded by dated outgoing SAP transfers.
const missingDateDraft={...draft,invoices:[{...draft.invoices[0],date:''},draft.invoices[1]]};
const recovered=collectInvoicesByDate([{id:'recovered',branch:draft.branch,payload:JSON.stringify(missingDateDraft)}],
  '2026-11-01','2026-11-02');
assert.equal(recovered.undatedInvoices,0);
assert.equal(recovered.inferredDates,1);
assert.equal(recovered.rows[0].date,'2026-11-01');
assert.equal(recovered.rows[0].dateSource,'transfer');
assert.equal(missingDateDraft.invoices[0].date,'','Reading the old register must never mutate its invoice dates');

const conflictingTransferDates={...draft,
  transfers:[{...first,date:'2026-11-03'},second],
  invoices:[{...draft.invoices[0],date:''},draft.invoices[1]]};
const unknown=collectInvoicesByDate([{id:'unknown',branch:draft.branch,doc_date:'2026-11-04',
  payload:JSON.stringify(conflictingTransferDates)}], '2026-11-01','2026-11-03');
assert.equal(unknown.undatedInvoices,1);
assert.equal(unknown.undatedDetails[0].number,'2610013337');
assert.equal(unknown.undatedDetails[0].branch,draft.branch);
assert.equal(unknown.undatedDetails[0].recordDate,'2026-11-04');
assert.deepEqual(unknown.undatedDetails[0].transferNumbers,['2615774','2615773']);
assert.match(unknown.undatedDetails[0].reason,/مختلفة/);
assert.equal(unknown.rows.length,1,'Unprovable date must stay out of date-scoped results');

const explicitlyLinked={...conflictingTransferDates,
  invoices:[{...conflictingTransferDates.invoices[0],dateTransferNos:['2615774']},draft.invoices[1]]};
const linked=collectInvoicesByDate([{id:'linked',branch:draft.branch,payload:JSON.stringify(explicitlyLinked)}],
  '2026-11-02','2026-11-02');
assert.equal(linked.rows[0].number,'2610013337');
assert.equal(linked.rows[0].dateSource,'transfer');
assert.equal(linked.rows[0].date,'2026-11-02');
assert.equal(linked.undatedInvoices,0);

const manuallyInvalid={...missingDateDraft,
  invoices:[{...missingDateDraft.invoices[0],manualDate:true},missingDateDraft.invoices[1]]};
const manual=collectInvoicesByDate([{id:'manual',branch:draft.branch,payload:JSON.stringify(manuallyInvalid)}],
  '2026-11-01','2026-11-02');
assert.equal(manual.undatedInvoices,1,'Do not overwrite a missing manually entered invoice date');
assert.match(manual.undatedDetails[0].reason,/يدوي/);

const reverse={...first,paste:header+'\nDAR00005\tcream\t2\tCarton\t011\t001'};
const reverseOnly={...draft,transfers:[reverse],invoices:[{...draft.invoices[0],date:''}]};
const reversed=collectInvoicesByDate([{id:'reverse',branch:draft.branch,payload:JSON.stringify(reverseOnly)}],
  '2026-11-01','2026-11-02');
assert.equal(reversed.undatedInvoices,1,'Never derive invoice date from a reversal transfer');
assert.equal(reversed.rows.length,0);

const outside=collectInvoicesByDate([{id:'outside',branch:draft.branch,payload:JSON.stringify(manuallyInvalid)}],
  '2026-12-01','2026-12-02');
assert.equal(outside.rows.length,0);
assert.equal(outside.undatedInvoices,1,
  'Report clearly identifies undated records from the whole register, not just the selected period');

// Approved historic MATCH groups remain recognized when dates are recovered, never edited.
const approvedMissing={...missingDateDraft,summary:{status:'match'}};
const approvedRecovered=collectInvoicesByDate([{id:'approved',branch:draft.branch,payload:JSON.stringify(approvedMissing)}],
  '2026-11-01','2026-11-02');
assert.deepEqual(approvedRecovered.rows.map(row=>row.groupConfirmedTransfers),
  [['2615774','2615773'],['2615774','2615773']]);

console.log('PASS: date-range invoice collector, exact amounts, verified transfer links, unknown group transfer safety, page sorter, and safe derived-date diagnostics.');
