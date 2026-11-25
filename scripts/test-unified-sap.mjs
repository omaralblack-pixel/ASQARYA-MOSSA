import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source=ts.transpileModule(fs.readFileSync('app/lib/unified-sap-query.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText;
const {unifiedSapQuery,isUnifiedSapSource,splitUnifiedSapSource,sapTransferUdfDiscoveryQuery}=
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
assert.equal(headers.length,32);
assert.ok(query.includes('H."U_ST_Remarks"'),'Default supplemental Remarks comes from verified OWTR UDF');
assert.ok(query.includes('H."U_Branch"'),'Branch comes from the dedicated OWTR U_Branch');
assert.ok(query.includes('H."Comments"'),'Blue invoice comes from OWTR Comments');
const onlySql=query.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n');
assert.equal((onlySql.match(/;/g)||[]).length,1,'Unified SAP query must contain exactly one SQL statement');
assert.ok(!onlySql.includes('FROM "CUFD"'),'Never append the field-discovery query to the export');
const sapFilesUi=fs.readFileSync('app/reconciliation/SapFiles.tsx','utf8');
assert.ok(sapFilesUi.includes('نسخ الكويري الشامل فقط'),'Use an explicit single-query copy action');
assert.ok(!sapFilesUi.includes('copySapUdfDiscovery')&&!sapFilesUi.includes('sapTransferUdfDiscoveryQuery'),
 'Remove obsolete second-query button after SAP column discovery');
assert.ok(sapTransferUdfDiscoveryQuery.includes('"CUFD"'));
assert.match(unifiedSapQuery('2026-11-01','2026-11-03','U_BlueRemarks'),
  /TO_NVARCHAR\(H\."U_BlueRemarks"\)/,
  'Read optional custom lower Remarks field only after confirming its SAP column');
assert.throws(()=>unifiedSapQuery('2026-11-01','2026-11-03','U_X"; DROP TABLE "OWTR"'),
  /اسم حقل الملاحظات/, 'Reject unsafe or unconfirmed SQL identifiers');
const row=object=>headers.map(key=>String(object[key]??'')).join('\t');
const exported=[
 headers.join('\t'),
 row({RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:'2026-11-03'}),
 row({RecordType:'TRANSFER',DocumentNumber:'2615754',DocumentDate:'2026-11-03',DocEntry:'89101',
   LineNumber:'1',ItemCode:'CHS00561',ItemName:'جبنة',Quantity:'10',Unit:'Piece',
   FromWarehouse:'001',ToWarehouse:'011',Remarks:'مؤسسة العقبة',JournalRemarks:'Inventory Transfers -',
    ExtraSapRemarks:'2623000001',BranchName:'84 — العقبة',CancellationStatus:'Y'}),
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
assert.ok(parts.transfers.includes('Extra SAP Remarks'));
assert.ok(parts.transfers.includes('Branch Name'));
assert.ok(parts.transfers.includes('84 — العقبة'));
// Exact SAP case: Comments contains blue invoice, U_ST_Remarks branch, and
// U_Branch is a verified dedicated field; Journal Remarks is generic text.
const exact=splitUnifiedSapSource(exported+'\n'+row({
 RecordType:'TRANSFER',DocumentNumber:'2616675',DocumentDate:'2026-11-16',
 ItemCode:'FVL00012',ItemName:'ذرة',Quantity:'1',Unit:'Carton',
 FromWarehouse:'001',ToWarehouse:'011',Remarks:'2623908380',
 ExtraSapRemarks:'صويلح',BranchName:'صويلح',
 JournalRemarks:'Inventory Transfers -',CancellationStatus:'N'
}));
const [transferNames,...transferLines]=exact.transfers.split('\n').map(line=>line.split('\t'));
const known=transferLines.find(line=>line[transferNames.indexOf('Document Number')]==='2616675');
assert.ok(known,'Transfer 2616675 must be available in exported 011 data');
assert.equal(known[transferNames.indexOf('Remarks')],'2623908380');
assert.equal(known[transferNames.indexOf('Extra SAP Remarks')],'صويلح');
assert.equal(known[transferNames.indexOf('Branch Name')],'صويلح');
assert.equal(known[transferNames.indexOf('Journal Remarks')],'Inventory Transfers -');
assert.ok(parts.transfers.includes('Inventory Transfers -'));
// An already-archived older unified source with 30 columns must still load.
for(const optionalColumns of [['BranchName'],['ExtraSapRemarks','BranchName']]){
  const removed=new Set(optionalColumns.map(name=>headers.indexOf(name)));
  const oldSource=exported.split('\n').map(line=>
    line.split('\t').filter((_,index)=>!removed.has(index)).join('\t')).join('\n');
  assert.equal(splitUnifiedSapSource(oldSource).counts.TRANSFER,1);
  assert.ok(splitUnifiedSapSource(oldSource).transfers.includes('Extra SAP Remarks'));
  assert.ok(splitUnifiedSapSource(oldSource).transfers.includes('Branch Name'));
}
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
assert.deepEqual(split.flatMap(part=>part.split('\n').slice(1)).sort(),[...repeatedRows].sort(),
 'Every SAP line must appear exactly once in the hash buckets');
const groups=new Map();
for(const [i,part] of split.entries())for(const line of part.split('\n').slice(1)){
 const doc=line.split('\t')[0];assert.ok(!groups.has(doc)||groups.get(doc)===i,
  'Never split a SAP transfer across two files');groups.set(doc,i);
}
assert.ok(split.every(part=>new TextEncoder().encode(part).length<=1500),
 'Every derived chunk must obey the physical byte limit');
// The same unchanged SAP documents must yield the same chunk bytes after
// new transfers are appended or a different document is canceled.
const transferColumns=transferHeader.split('\t');
const cancelIndex=transferColumns.indexOf('CANCELED');
assert.ok(cancelIndex>=0);
const docLine=i=>transferLine.replace('2615754',String(2640000+i));
const baselineRows=Array.from({length:1280},(_,i)=>[docLine(i),docLine(i)]).flat();
const baseline=splitSapSectionIntoChunks(transferHeader+'\n'+baselineRows.join('\n'),'transfers',20_000);
const alteredRows=[...baselineRows];
const changedCells=alteredRows[100].split('\t');
changedCells[cancelIndex]=changedCells[cancelIndex]==='N'?'Y':'N';
alteredRows[100]=changedCells.join('\t');
alteredRows.push(docLine(1280),docLine(1281),docLine(1282));
const next=splitSapSectionIntoChunks(transferHeader+'\n'+alteredRows.join('\n'),'transfers',20_000);
assert.ok(baseline.length>=6,'Synthetic transfers should span multiple independently reusable chunks');
const same=new Set(baseline);
const reused=next.filter(chunk=>same.has(chunk)).length;
assert.ok(reused>=baseline.length-3,'Unrelated content-defined chunks must remain identical: '+reused+'/'+baseline.length);
assert.deepEqual(next.flatMap(chunk=>chunk.split('\n').slice(1)).sort(),[...alteredRows].sort(),
 'New and changed SAP records must not be dropped or duplicated');
assert.deepEqual(splitSapSectionIntoChunks(transferHeader+'\n'+
 baselineRows.slice(100).concat(baselineRows.slice(0,100)).join('\n'),'transfers',20_000),baseline,
 'Reordering whole SAP documents must not invalidate unchanged content-addressed chunks');
console.log('PASS: deterministic SAP bucket reuse: '+reused+'/'+baseline.length+
 ' content-defined chunks reused after three new transfers and one cancellation; every line preserved.');
// Both layouts are lossless; the caller selects the layout with the highest
// already-approved byte reuse. Sequential must remain a safe fallback.
const sequential=splitSapSectionIntoChunks(longTransfer,'transfers',1500,'sequential');
assert.deepEqual(sequential.flatMap(part=>part.split('\n').slice(1)),repeatedRows);
assert.ok(sequential.every(part=>new TextEncoder().encode(part).length<=1500));
assert.equal(splitSapSectionIntoChunks(parts.official,'official',1500).length,1);
assert.equal(splitSapSectionIntoChunks(parts.journal,'journal',1500).length,1);
assert.match(fs.readFileSync('app/reconciliation/SapFiles.tsx','utf8'),
 /processUnifiedFile\(file,source\)/,
 'Large unified source must use split processing instead of one CPU-bound plan');
console.log('PASS: immutable SAP sections, document-preserving chunks, complete lines, CPU-safe byte budgets.');
