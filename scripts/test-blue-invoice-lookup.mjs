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
console.log('PASS: SAP archived invoice 2623224070 / transfers 2616485 and 2616486, newer Remarks, no old overwrite, cancellation and branch guards.');
