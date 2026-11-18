import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source=ts.transpileModule(fs.readFileSync('app/lib/unified-sap-query.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText;
const {unifiedSapQuery,isUnifiedSapSource,splitUnifiedSapSource}=
  await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
for(const [from,to] of [
 ['2026-11-31','2026-12-01'],['2026-11-04','2026-11-01'],
 ["2026-11-01'); DROP TABLE OWTR;--",'2026-11-17'],
 ['2026-02-29','2026-11-17'],
])assert.throws(()=>unifiedSapQuery(from,to),'Reject invalid or injected dates');
assert.ok(unifiedSapQuery('2028-02-29','2028-03-02'));
const query=unifiedSapQuery('2026-11-01','2026-11-03');
assert.ok(query.includes('FROM DUMMY'),'Period metadata independent of stock rows');
assert.ok(query.includes('H."JrnlMemo"'),'Keep Journal Remarks');
assert.ok(query.includes('H."Comments"'),'Keep regular Remarks');
assert.ok(query.includes('H."CANCELED"'),'Keep cancellation state');
assert.ok(!/CANCELED"\s*=\s*'N'/.test(query),'Never discard canceled records');
assert.ok(query.includes('M."DocDate" < TO_DATE'),'Opening is before day one');
assert.ok(query.includes('M."DocDate" <= TO_DATE'),'Closing includes selected day');
assert.ok(query.includes('M."TransNum"'),'OINM is included');
assert.ok(query.includes('C0006751'),'Only Aqaba official customer is scoped');
for(const table of ['"OWTR"','"WTR1"','"OINM"','"OINV"','"ORIN"','"ODLN"','"ORDN"'])
 assert.ok(query.includes(table),'Missing table '+table);
const headers=[...query.split('\nUNION ALL\n')[0].matchAll(/ AS "([^"]+)"/g)].map(match=>match[1]);
assert.equal(headers.length,30);
const row=object=>headers.map(key=>String(object[key]??'')).join('\t');
const exported=[
 headers.join('\t'),
 row({RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:'2026-11-03'}),
 row({RecordType:'TRANSFER',DocumentNumber:'2615754',DocumentDate:'2026-11-03',DocEntry:'89101',
   LineNumber:'1',ItemCode:'CHS00561',ItemName:'جبنة',Quantity:'10',Unit:'Piece',
   FromWarehouse:'001',ToWarehouse:'011',Remarks:'مؤسسة العقبة',JournalRemarks:'2623000001',CancellationStatus:'Y'}),
 row({RecordType:'OPENING',DocumentDate:'2026-11-01',ItemCode:'CHS00561',ItemName:'جبنة',
   Unit:'Piece',Warehouse:'011',StockQuantity:'5'}),
 row({RecordType:'CLOSING',DocumentDate:'2026-11-03',ItemCode:'CHS00561',ItemName:'جبنة',
   Unit:'Piece',Warehouse:'011',StockQuantity:'15'}),
 row({RecordType:'OINM',DocumentDate:'2026-11-03',DocumentNumber:'2615754',
   TransNum:'101',TransType:'67',DocEntry:'89101',LineNumber:'0',
   ItemCode:'CHS00561',ItemName:'جبنة',Warehouse:'011',InQty:'10',OutQty:'0'}),
 row({RecordType:'OFFICIAL',DocumentType:'IN',DocumentNumber:'260063818',DocEntry:'441',
   DocumentDate:'2026-11-03',LineNumber:'1',CardCode:'C0006751',Warehouse:'011',
   ItemCode:'CHS00561',ItemName:'جبنة',Quantity:'10',Unit:'Piece',Price:'0.313',
   LineTotal:'3.13',CancellationStatus:'Y'})
].join('\n');
assert.ok(isUnifiedSapSource(exported));
const parts=splitUnifiedSapSource(exported);
assert.equal(parts.from,'2026-11-01');
assert.equal(parts.to,'2026-11-03');
for(const kind of ['WINDOW','TRANSFER','OPENING','CLOSING','OINM','OFFICIAL'])
 assert.equal(parts.counts[kind],1,'Section count '+kind);
assert.deepEqual(parts.warnings,[]);
const flagged=splitUnifiedSapSource(exported.replace('مؤسسة العقبة','2623323211 262332321 2623323212'));
assert.equal(flagged.warnings.length,1);
assert.ok(flagged.warnings[0].includes('262332321'));
assert.equal(flagged.counts.TRANSFER,1,'Warning must not drop a transfer');
assert.ok(parts.transfers.includes('2615754'));
assert.ok(parts.transfers.includes('2623000001'));
assert.ok(parts.transfers.includes('\tY'));
assert.ok(parts.opening.includes('\t5'));
assert.ok(parts.closing.includes('\t15'));
assert.ok(parts.official.includes('260063818'));
assert.ok(parts.journal.includes('2615754'));
assert.throws(()=>splitUnifiedSapSource(exported.replace('WINDOW','WRONG')));
assert.throws(()=>splitUnifiedSapSource(exported+'\nINVALID'));
assert.equal(isUnifiedSapSource('رقم الترحيل\tالتاريخ\n1\t2026-11-03'),false);
console.log('PASS: unified query period, cancellation, all SAP sources, tagged export routing, rejection of malformed files.');
const chunksSource=ts.transpileModule(fs.readFileSync('app/lib/sap-unified-chunks.ts','utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}
}).outputText;
const {splitSapSectionIntoChunks}=
 await import('data:text/javascript;base64,'+Buffer.from(chunksSource).toString('base64'));
const transferHeader=parts.transfers.split('\n')[0];
const transferLine=parts.transfers.split('\n')[1];
const repeatedRows=Array.from({length:160},(_,i)=>transferLine.replace('2615754',String(2619000+Math.floor(i/2))));
const longTransfer=transferHeader+'\n'+repeatedRows.join('\n');
const split=splitSapSectionIntoChunks(longTransfer,'transfers',1500);
assert.ok(split.length>1,'Large SAP transfer source must split under the CPU budget');
assert.deepEqual(split.flatMap(part=>part.split('\n').slice(1)),repeatedRows,
 'Every SAP line must appear once and retain its order');
const groups=new Map();
for(const [i,part] of split.entries())for(const line of part.split('\n').slice(1)){
 const doc=line.split('\t')[0];assert.ok(!groups.has(doc)||groups.get(doc)===i,
  'Never split a SAP transfer across two files');groups.set(doc,i);
}
assert.ok(split.every(part=>new TextEncoder().encode(part).length<=1500),
 'Every derived chunk must obey the physical byte limit');
assert.equal(splitSapSectionIntoChunks(parts.official,'official',1500).length,1);
assert.equal(splitSapSectionIntoChunks(parts.journal,'journal',1500).length,1);
assert.match(fs.readFileSync('app/reconciliation/SapFiles.tsx','utf8'),
 /processUnifiedFile\(file,source\)/,
 'Large unified source must use split processing instead of one CPU-bound plan');
console.log('PASS: immutable SAP sections, document-preserving chunks, complete lines, CPU-safe byte budgets.');
