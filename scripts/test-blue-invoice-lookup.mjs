import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';

const archives=new Map();
const files=[
 {key:'lieutenant/transfers__11111111111111111111111111111111__new.txt',name:'new.txt',kind:'transfers',created:'2026-11-16T08:00:00Z'},
 {key:'lieutenant/transfers__22222222222222222222222222222222__old.txt',name:'old.txt',kind:'transfers',created:'2026-11-14T08:00:00Z'}
];
const header=['Document Number','Document Date','Branch Code','Branch Name','Remarks',
 'Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'].join('\t');
const row=(transfer,invoice)=>[transfer,'2026-11-14','21','السرو','Blue invoice '+invoice,
 'DAR00005','Cream','1','Piece','001','011'].join('\t');
archives.set(files[0].key,header+'\n'+row('2616485','2623224070')+'\n'+row('2616486','2623224070'));
archives.set(files[1].key,header+'\n'+row('2616485','2623224071'));
const cache=new Map();
function load(file){
 file=resolve(file);if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{
   target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true
 }}).outputText;
 new Function('exports','require',js)(exports,name=>{
   if(name==='./sap-files-client')return {
     listSapFiles:async()=>files,
     readSapArchive:async file=>archives.get(file.key)??'',
   };
   if(name.startsWith('.')&&!name.endsWith('.json'))return load(resolve(dirname(file),name+'.ts'));
   return createRequire(file)(name);
 });
 return exports;
}
const {searchArchivedSapEvidence,groupSapEvidence}=load('app/lib/sap-document-lookup.ts');
const branches=['21 — السرو'];
const {parseSapImport,readSapImportRows,sapBranchFromRemarks}=load('app/lib/sap-import.ts');
const {parseLieutenantTransfers}=load('app/lib/lieutenant.ts');
// Instant Match uses the same SAP originals; English column names must never
// cause false "missing Arabic columns" errors.
const englishImported=parseSapImport(archives.get(files[0].key),branches);
assert.deepEqual(englishImported.issues,[]);
assert.equal(englishImported.groups.length,1);
assert.equal(englishImported.groups[0].members.length,2);
assert.deepEqual(englishImported.groups[0].draft.invoices.map(row=>row.number),['2623224070']);
assert.ok(englishImported.groups[0].members.every(row=>!row.issues.length));
// The unified 011 query deliberately omits the branch columns. Its transfer
// remains readable but cannot be silently accepted without verified branch.
const unifiedHeader=['Document Number','Document Date','Item No.','Item Description',
 'Quantity','UoM Code','From Warehouse','To Warehouse','Journal Remarks','CANCELED'].join('\t');
const unifiedRow=['2616487','2026-11-14','DAR00005','Cream','1','Piece','001','011',
 'Blue invoice 2623224070','N'].join('\t');
const unifiedText=unifiedHeader+'\n'+unifiedRow;
assert.deepEqual(readSapImportRows(unifiedText).issues,[]);
const noBranch=parseSapImport(unifiedText,branches);
assert.equal(noBranch.groups.length,1);
assert.equal(noBranch.groups[0].members[0].branch,'');
assert.deepEqual(noBranch.groups[0].members[0].issues,['الفرع غير معروف']);
assert.equal(noBranch.groups[0].draft.invoices[0].number,'2623224070');
// Explicit canceled status must always block instant matching, even with
// positive quantity and no cancellation phrase in Remarks.
const canceled=parseSapImport(unifiedHeader+'\n'+unifiedRow.replace(/\tN$/,'\tY'),branches);
assert.equal(canceled.groups[0].members[0].reversal,true);
assert.deepEqual(canceled.groups[0].members[0].invoices,[]);
assert.equal(canceled.groups[0].reversal,true);
// Both Remarks columns contribute evidence; repeated export headers are data
// separators, never invalid transfer numbers.
const journalHeader=header+'\tJournal Remarks\tCANCELED';
const journalRow=row('2616488','2623224070').replace('Blue invoice 2623224070','Branch reference')+
 '\tBlue invoice 2623224070\tN';
const journal=parseSapImport([journalHeader,journalRow,journalHeader,journalRow.replace('2616488','2616489')].join('\n'),branches);
assert.equal(journal.issues.length,0);
assert.equal(journal.groups[0].members.length,2);
assert.deepEqual(journal.groups[0].draft.invoices.map(row=>row.number),['2623224070']);
// Regression from SAP Inventory Transfer 2616675 (16 Nov 2026):
// upper Remarks = صويلح, lower Remarks = blue invoice 2623908380.
const branchList=[...branches,'22 — صويلح'];
assert.equal(sapBranchFromRemarks('صويلح\n2623908380',branchList),'22 — صويلح');
assert.equal(sapBranchFromRemarks('صويلح\nالسرو',branchList),'',
 'Two branch names are ambiguous: do not assign either automatically');
const dualRemarksHeader=['Document Number','Document Date','Item No.','Item Description',
 'Quantity','UoM Code','From Warehouse','To Warehouse','Remarks','Remarks 2'].join('\t');
const dualRemarksRow=['2616675','2026-11-16','FVL00012','Vegetables','1','Carton','001','011',
 'صويلح','2623908380'].join('\t');
const screenshot=parseSapImport(dualRemarksHeader+'\n'+dualRemarksRow,branchList);
assert.equal(screenshot.issues.length,0);
assert.equal(screenshot.groups.length,1);
assert.equal(screenshot.groups[0].draft.branch,'22 — صويلح');
assert.deepEqual(screenshot.groups[0].draft.invoices.map(x=>x.number),['2623908380']);
assert.equal(screenshot.groups[0].members[0].transfer.number,'2616675');
const queuedScreenshot=groupSapEvidence([{
 transfer:screenshot.groups[0].members[0].transfer,branch:'',
 remarks:'صويلح\n2623908380',invoiceNumbers:['2623908380'],reverse:false,
 cancellationState:'unknown',sourceFile:'old-file'
}], '2623908380','invoice',branchList);
assert.equal(queuedScreenshot?.draft.branch,'22 — صويلح');
assert.equal(queuedScreenshot?.issues.length,0);
// If the SAP export lacks its lower Remarks column, the invoice must not be
// invented from a screenshot or synthesized from the transfer number.
const missingSecond=parseSapImport(dualRemarksHeader.replace('\tRemarks 2','')+'\n'+
 dualRemarksRow.replace('\t2623908380',''),branchList);
assert.equal(missingSecond.groups[0].draft.branch,'22 — صويلح');
assert.deepEqual(missingSecond.groups[0].members[0].invoices,[]);
// Verified OWTR field mapping: Comments=blue invoice, JrnlMemo=system notes,
// U_ST_Remarks=branch notes, U_Branch=dedicated branch field.
const verifiedHeader=['Document Number','Document Date','Branch Name','Remarks',
 'Journal Remarks','Extra SAP Remarks','Item No.','Item Description',
 'Quantity','UoM Code','From Warehouse','To Warehouse','CANCELED'].join('\t');
const verifiedRow=['2616675','2026-11-16','صويلح','2623908380',
 'Inventory Transfers -','صويلح','FVL00012','ذرة',
 '1','Carton','001','011','N'].join('\t');
const verifiedText=verifiedHeader+'\n'+verifiedRow;
const verified=parseSapImport(verifiedText,branchList);
assert.deepEqual(verified.issues,[]);
assert.equal(verified.groups.length,1);
assert.equal(verified.groups[0].issues.length,0);
assert.equal(verified.groups[0].members[0].branch,'22 — صويلح');
assert.equal(verified.groups[0].members[0].reversal,false);
assert.equal(verified.groups[0].draft.invoices[0].number,'2623908380');
const queued=parseLieutenantTransfers(verifiedText,branchList);
assert.equal(queued.issues.length,0);
assert.equal(queued.transfers.length,1);
assert.equal(queued.transfers[0].branch,'22 — صويلح');
assert.deepEqual(queued.transfers[0].invoiceNumbers,['2623908380']);
assert.equal(queued.transfers[0].cancellationState,'active');
assert.deepEqual(queued.transfers[0].issues,[]);
// U_Branch may contain a numeric branch code in some SAP exports.
const codeBranch=verifiedText.replace('\tصويلح\t2623908380','\t22\t2623908380');
assert.equal(parseSapImport(codeBranch,branchList).groups[0].draft.branch,'22 — صويلح');
assert.equal(parseLieutenantTransfers(codeBranch,branchList).transfers[0].branch,'22 — صويلح');
// Do not approve a different branch silently if U_Branch contradicts notes.
const conflicting=verifiedText.replace('\tصويلح\t2623908380','\tالسرو\t2623908380');
assert.ok(parseSapImport(conflicting,branchList).groups[0].issues.some(note=>note.includes('تعارض فرع SAP')));
assert.ok(parseLieutenantTransfers(conflicting,branchList).transfers[0].issues.some(note=>note.includes('تعارض فرع SAP')));
const report=await searchArchivedSapEvidence('2623224070','invoice',branches);
assert.equal(report.unreadable,0);
assert.deepEqual(report.hits.map(row=>row.transfer.number).sort(),['2616485','2616486']);
const transfer=await searchArchivedSapEvidence('2616485','transfer',branches);
assert.equal(transfer.hits.length,1);
assert.deepEqual(transfer.hits[0].invoiceNumbers,['2623224070'],'new SAP evidence must win over old export');
assert.deepEqual((await searchArchivedSapEvidence('2623224071','invoice',branches)).hits,[],
  'Older conflicting Remarks cannot override newer archived originals');
const grouped=groupSapEvidence(report.hits,'2623224070','invoice');
assert.ok(grouped);
assert.equal(grouped.draft.transfers.length,2);
assert.equal(grouped.draft.invoices[0].number,'2623224070');
assert.deepEqual(grouped.draft.invoices[0].dateTransferNos.sort(),['2616485','2616486']);
assert.equal(grouped.issues.length,0);
assert.equal(groupSapEvidence(report.hits,'2623224071','invoice'),null);
const blocked=groupSapEvidence(report.hits.map(row=>({...row,cancellationState:'canceled'})),
  '2623224070','invoice');
assert.equal(blocked.reversal,true,'Canceled documents are not auto-approved as normal invoices');
const mixed=groupSapEvidence(report.hits.map((row,i)=>({...row,branch:i?'22 — Other':'21 — السرو'})),
  '2623224070','invoice');
assert.ok(mixed.issues.some(note=>note.includes('فروع مختلفة')));
// A reverse 011 movement is review-only evidence, never proof of cancellation.
const reverseRow=row('2616818','2623224070').replace('\t001\t011','\t011\t001');
const reverseParsed=parseLieutenantTransfers(header+'\n'+reverseRow,branches);
assert.equal(reverseParsed.transfers.length,1);
assert.equal(reverseParsed.transfers[0].reverse,true);
const reverseGroup=groupSapEvidence([{
  transfer:reverseParsed.transfers[0].transfer,
  branch:reverseParsed.transfers[0].branch,
  remarks:reverseParsed.transfers[0].remarks,
  invoiceNumbers:reverseParsed.transfers[0].invoiceNumbers,
  reverse:reverseParsed.transfers[0].reverse,
  cancellationState:'active',
  sourceFile:'sap-reverse.txt'
}], '2616818','transfer',branches);
assert.equal(reverseGroup?.members[0].reverseMovement,true);
assert.equal(reverseGroup?.draft.transfers[0].number,'2616818');
console.log('PASS: SAP archived invoice 2623224070 / transfers 2616485 and 2616486, 011 reverse movement, cancellation and branch guards.');
