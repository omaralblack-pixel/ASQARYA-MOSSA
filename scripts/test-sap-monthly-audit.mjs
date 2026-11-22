import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compareSapSources} from './audit-sap-monthly-sources.mjs';

const folder=mkdtempSync(join(tmpdir(),'sap-monthly-audit-'));
const head=['#','RecordType','DocumentType','DocumentNumber','DocEntry','DocumentDate',
 'LineNumber','ItemCode','ItemName','Unit','Quantity','FromWarehouse','ToWarehouse',
 'Warehouse','InQty','OutQty','StockQuantity','TransNum','TransType','CardCode',
 'CardName','CancellationStatus','Remarks','JournalRemarks','Price','LineTotal',
 'VatSum','BaseType','BaseEntry','BaseLine','BaseRef',''];
const H=Object.fromEntries(head.map((x,i)=>[x,i]));
function row(n,fields){
 const cells=Array.from({length:head.length},()=> '');
 cells[H['#']]=String(n);
 for(const [key,value] of Object.entries(fields))cells[H[key]]=String(value);
 return cells.join('\t');
}
function makeSource(to,changed=false,remove=false){
 const d=[
  row(1,{RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:to}),
  row(2,{RecordType:'OPENING',DocumentDate:'2026-11-01',ItemCode:'FVL00100',StockQuantity:'20.000'}),
  row(3,{RecordType:'CLOSING',DocumentDate:to,ItemCode:'FVL00100',StockQuantity:'25.000'}),
  row(4,{RecordType:'TRANSFER',DocumentNumber:'2616000',DocEntry:'10',
   DocumentDate:'2026-11-08',LineNumber:'1',ItemCode:'FVL00100',Quantity:'2',
   FromWarehouse:'001',ToWarehouse:'011',CancellationStatus:changed?'Y':'N',Remarks:'2621000000'}),
  row(5,{RecordType:'OFFICIAL',DocumentType:'IN',DocEntry:'52',DocumentNumber:'2621000000',
   DocumentDate:'2026-11-08',LineNumber:'1',ItemCode:'FVL00100',Quantity:'2'}),
  row(6,{RecordType:'OINM',TransNum:'101',DocumentDate:'2026-11-08',LineNumber:'1',
   ItemCode:'FVL00100',InQty:'2',Warehouse:'011'}),
 ];
 if(remove)d.splice(3,1);
 if(changed)d.push(row(7,{RecordType:'TRANSFER',DocumentNumber:'2616001',DocEntry:'11',
   DocumentDate:'2026-11-22',LineNumber:'1',ItemCode:'FVL00100',Quantity:'4',
   FromWarehouse:'002',ToWarehouse:'011',CancellationStatus:'N'}));
 return head.join('\t')+'\n'+d.join('\n')+'\n';
}
try{
 const old=join(folder,'21.txt'),next=join(folder,'22.txt'),wrong=join(folder,'removed.txt');
 const body=makeSource('2026-11-21');
 writeFileSync(old,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(body,'utf16le')]));
 writeFileSync(next,makeSource('2026-11-22',true));
 const result=compareSapSources(old,next);
 assert.equal(result.scope.before.to,'2026-11-21');
 assert.equal(result.scope.after.to,'2026-11-22');
 assert.equal(result.kinds.TRANSFER.added,1);
 assert.equal(result.kinds.TRANSFER.modified,1);
 assert.equal(result.kinds.TRANSFER.disappeared,0);
 assert.equal(result.kinds.OPENING.modified,0);
 assert.equal(result.kinds.OFFICIAL.modified,0);
 assert.equal(result.safeForManualReview,true);
 assert.equal(result.cancellations.before.N,1);
 assert.equal(result.cancellations.after.Y,1);
 writeFileSync(wrong,makeSource('2026-11-22',false,true));
 const missing=compareSapSources(old,wrong);
 assert.equal(missing.kinds.TRANSFER.disappeared,1);
 assert.equal(missing.safeForManualReview,false);
 assert.ok(missing.warnings.some(x=>x.includes('اختفاء')));
 writeFileSync(wrong,body.replace('TRANSFER','BROKEN'));
 assert.throws(()=>compareSapSources(wrong,next),/نوع سجل غير معروف/);
 // SAP export line numbers must not affect original document fingerprints.
 writeFileSync(wrong,body.replace(/\n([1-9])\t/g,(_,n)=>'\n'+(Number(n)+20)+'\t'));
 const reordered=compareSapSources(old,wrong);
 assert.equal(reordered.kinds.TRANSFER.modified,0);
 assert.equal(reordered.kinds.OFFICIAL.modified,0);
 console.log('PASS: UTF-16LE source, SAP row-number exclusions, cancellations, new records, malformed data and missing-transfer warnings');
}finally{rmSync(folder,{recursive:true,force:true});}
