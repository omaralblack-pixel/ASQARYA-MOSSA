import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const compile=(path)=>ts.transpileModule(fs.readFileSync(path,'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText;
const reconcileUrl='data:text/javascript;base64,'+Buffer.from(compile('app/lib/reconcile.ts')).toString('base64');
const lieutenantCode=compile('app/lib/lieutenant.ts')
  .replace(/from ['"]\.\/reconcile['"]/, 'from "'+reconcileUrl+'"');
const {parseLieutenantTransfers}=await import('data:text/javascript;base64,'+Buffer.from(lieutenantCode).toString('base64'));

const ar=['رقم الترحيل','التاريخ','كود الصنف','اسم الصنف','من مستودع','إلى مستودع','الكمية','الوحدة','حالة الإلغاء','ملاحظات'].join('\t');
const rows=[
 ['2617000','2026-11-01','FVL00016','جزر ريفي','002','011','11','Piece','N','2623014032'],
 ['2617000','2026-11-01','FVL00017','ملوخية ريفي','002','011','2','Carton','N','2623014032'],
 ['2617001','2026-11-02','FVL00016','جزر ريفي','011','003','11','Piece','N','عكسي'],
 ['2617002','2026-11-03','FVL00016','جزر ريفي','011','002','11','Piece','C','Inventory transfer no. 2617000 has been canceled'],
 ['2617003','2026-11-03','FVL00016','جزر ريفي','001','011','11','Piece','Y',''],
 ['2617004','2026-11-03','DAR00005','كريمة','004','007','5','Piece','N',''],
];
const scan=parseLieutenantTransfers([ar,...rows.map(x=>x.join('\t'))].join('\n'),[]);
assert.equal(scan.issues.length,0);
assert.deepEqual(scan.transfers.map(r=>r.transfer.number),['2617000','2617001','2617002','2617003']);
assert.equal(scan.transfers[0].lineCount,2);
assert.equal(scan.transfers[0].invoiceNumbers[0],'2623014032');
assert.equal(scan.transfers[1].reverse,true,'Do not discard a reverse to warehouse 003');
assert.equal(scan.transfers[2].cancellationState,'cancellation');
assert.equal(scan.transfers[2].cancellationMentioned,true);
assert.equal(scan.transfers[3].cancellationState,'canceled');
assert.equal(scan.transfers[0].transfer.paste.split('\n').length,3);

const en=['رقم الترحيل','تاريخ الترحيل','كود الفرع','اسم الفرع','Remarks','Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'].join('\t');
const normal=[
 '2617005','01/11/2026','21','السرو','2623014032','FVL00016','جزر ريفي','3','Piece','001','011',
].join('\t');
const normalScan=parseLieutenantTransfers(en+'\n'+normal,['21 — السرو']);
assert.equal(normalScan.issues.length,0);
assert.equal(normalScan.transfers[0].branch,'21 — السرو');
assert.equal(normalScan.transfers[0].cancellationState,'unknown','No CANCELED column means unknown, not active');
const wrong=[...rows[0]];wrong[7]='Crate';
const invalid=parseLieutenantTransfers(ar+'\n'+wrong.join('\t'),[]);
assert.ok(invalid.transfers[0].issues.some(x=>x.includes('وحدة')));
const blank=parseLieutenantTransfers('hello\tworld\n123\t456',[]);
assert.ok(blank.issues[0].includes('أعمدة'));
const repeated=parseLieutenantTransfers(ar+'\n'+rows[0].join('\t')+'\n'+ar+'\n'+rows[1].join('\t'),[]);
assert.equal(repeated.transfers.length,1,'Repeated headers do not create fake transfers');
assert.equal(repeated.issues.length,0);
const excelEpoch=Date.UTC(1899,11,30);
const excelSerial=Math.floor((Date.UTC(2026,10,1)-excelEpoch)/86400000);
const excelRow=normal.replace('01/11/2026',String(excelSerial));
const excelScan=parseLieutenantTransfers(en+'\n'+excelRow,['21 — السرو']);
assert.equal(excelScan.transfers[0].transfer.date,'2026-11-01','Excel serial dates must be preserved');
const englishHeader=['Document Number','Document Date','Branch Code','Branch Name','Remarks','Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'].join('\t');
const englishScan=parseLieutenantTransfers([englishHeader,
 ['2617006','01/11/2026','21','السرو','','DAR00005','كريمة','1','Piece','001','011'].join('\t'),
 englishHeader,
 ['2617007','02/11/2026','21','السرو','','DAR00005','كريمة','1','Piece','011','001'].join('\t')
].join('\n'),['21 — السرو']);
assert.equal(englishScan.issues.length,0,'Repeated English headers must be ignored');
assert.equal(englishScan.transfers.length,2,'Both English-header transfers must survive');
const schema=JSON.parse(fs.readFileSync('app/lib/reconciliation-schema.json','utf8'));
assert.ok(schema.some(sql=>sql.includes('CREATE TABLE IF NOT EXISTS lieutenant_opening_stock')&&
  sql.includes('PRIMARY KEY (snapshot_date, warehouse, sap_code, unit)')),'Opening balances have a durable unique key');
const initial=schema.find(sql=>sql.startsWith('INSERT OR IGNORE INTO lieutenant_opening_stock'));
assert.ok(initial&&initial.includes("'2026-11-01','011','FVL00368'")&&
  initial.includes("'Piece',5.000,"),'Approved rice opening stock is five pieces, not five thousand');
assert.ok(fs.readFileSync('app/api/reconcile/route.ts','utf8').includes('openingStock:openingStock.results'));
assert.ok(fs.readFileSync('app/reconciliation/FirstLieutenant.tsx','utf8').includes('snapshot.openingStock.map'));


const counterpartCode=compile('app/lib/lieutenant-counterparts.ts');
const {analyzeLieutenantMovements,isCashVanTransfer}=
  await import('data:text/javascript;base64,'+Buffer.from(counterpartCode).toString('base64'));
const cashRows=[
 ['2615767','02/11/2026','','','كاش فان عجلون','DAR00005','كريمة','12','Piece','001','011'],
 ['2616500','11/11/2026','','','عكس ترحيل 2615767','DAR00005','كريمة','12','Piece','011','001'],
];
const cashData=[englishHeader,...cashRows.map(row=>row.join('\t'))].join('\n');
const cashScan=parseLieutenantTransfers(cashData,['7 — عجلون']);
assert.equal(cashScan.issues.length,0);
assert.equal(cashScan.transfers[0].branch,'7 — عجلون','Recognize Cash Van Ajloun from remarks');
assert.equal(isCashVanTransfer(cashScan.transfers[0]),true);
const cashResolved=analyzeLieutenantMovements(cashScan.transfers,'2026-11-30');
assert.equal(cashResolved.get('2615767').kind,'reversed','Cash Van with matching reverse is not an invoice gap');
assert.equal(cashResolved.get('2615767').counterpart,'2616500');
assert.equal(cashResolved.get('2616500').kind,'reverse','The reverse is not a second blue-invoice requirement');
assert.ok(cashResolved.get('2615767').note.includes('ليس إلغاء SAP'),'Reversal is not official SAP cancellation');
const cutoff=analyzeLieutenantMovements(cashScan.transfers,'2026-11-03');
assert.equal(cutoff.get('2615767').kind,'cashvan-pending','Reverse posted after audit date cannot settle earlier stock');
assert.ok(cutoff.get('2615767').note.includes('2026-11-11'));
const cashWithoutRemark=[...cashRows[1]];cashWithoutRemark[4]='بدون ملاحظات';
const noRefScan=parseLieutenantTransfers([englishHeader,cashRows[0].join('\t'),cashWithoutRemark.join('\t')].join('\n'),['7 — عجلون']);
assert.equal(analyzeLieutenantMovements(noRefScan.transfers,'2026-11-30').get('2615767').kind,'reversed',
  'One unique exact inverse must be recognized even without an explicit reference');
const duplicateExplicit=[...cashRows[1]];duplicateExplicit[0]='2616501';
const manyReversals=parseLieutenantTransfers(
  [englishHeader,cashRows[0].join('\t'),cashRows[1].join('\t'),duplicateExplicit.join('\t')].join('\n'),
  ['7 — عجلون']);
assert.equal(analyzeLieutenantMovements(manyReversals.transfers,'2026-11-30').get('2615767').kind,'cashvan-pending',
  'Two reversals explicitly claiming one original are ambiguous');
const secondCash=[...cashRows[0]];secondCash[0]='2615768';
const ambiguousScan=parseLieutenantTransfers([englishHeader,cashRows[0].join('\t'),secondCash.join('\t'),cashWithoutRemark.join('\t')].join('\n'),['7 — عجلون']);
assert.equal(analyzeLieutenantMovements(ambiguousScan.transfers,'2026-11-30').get('2615767').kind,'cashvan-pending',
  'Do not auto-match one reversal to two identical Cash Vans');
const partialForward=['2617008','02/11/2026','','','كاش فان عجلون','DAR00027','كريمة أخرى','3','Piece','001','011'].join('\t');
const partialScan=parseLieutenantTransfers([englishHeader,cashRows[0].join('\t'),partialForward,cashWithoutRemark.join('\t')].join('\n'),['7 — عجلون']);
assert.equal(analyzeLieutenantMovements(partialScan.transfers,'2026-11-30').get('2617008').kind,'cashvan-pending',
  'A different inventory item cannot be canceled by an unrelated reverse');
const canceledHeader=ar;
const originalCancel=['2617010','2026-11-02','DAR00005','كريمة','001','011','12','Piece','Y','كاش فان عجلون'];
const officialCancel=['2617011','2026-11-03','DAR00005','كريمة','011','001','12','Piece','C','Inventory transfer no. 2617010 has been canceled'];
const canceledScan=parseLieutenantTransfers([canceledHeader,originalCancel.join('\t'),officialCancel.join('\t')].join('\n'),[]);
const canceledResolved=analyzeLieutenantMovements(canceledScan.transfers,'2026-11-30');
assert.equal(canceledResolved.get('2617010').kind,'sap-canceled');
assert.equal(canceledResolved.get('2617011').kind,'sap-cancel-doc');

const screen=fs.readFileSync('app/reconciliation/FirstLieutenant.tsx','utf8');
assert.ok(screen.includes("response.headers.get('content-type')"),'HTML responses need a friendly diagnostic');
assert.ok(screen.includes("movements.get(row.transfer.number)?.kind==='normal'"),'Auto-import must skip reversals and Cash Van');
assert.ok(screen.includes("soldierEligible(row.status)"),'Settled Cash Van should not be sent to soldier');
console.log('PASS: Lieutenant Cash Van matching, period cutoff, uniqueness, SAP cancellation, import exclusion and HTML-response diagnosis.');


const archiveRoute=fs.readFileSync('worker/institution.ts','utf8');
const routeStart=archiveRoute.indexOf('async function lieutenantFiles(');
const routeEnd=archiveRoute.indexOf('export async function handleInstitution(',routeStart);
assert.ok(routeStart>0&&routeEnd>routeStart,'Archive route must exist within authenticated worker');
const isolatedArchive=compileText(archiveRoute.slice(routeStart,routeEnd));
function compileText(source){
  return ts.transpileModule(source,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
  }).outputText;
}
const archivedKey='lieutenant/transfers__'+'a'.repeat(32)+'__011.txt';
const deletedObjects=[];
const storageContext={
  URL,Response,Headers,Buffer,
  storagePath:'/storage/v1/object',bucket:'institution-sap',privateHeaders:{'Cache-Control':'no-store'},
  maxSapFileBytes:16*1024*1024,
  readBody:async(request,limit)=>{
    const body=await request.text();
    if(body.length>limit)throw Error('Too large');
    return body;
  },
  reply:(status,error)=>Response.json({error},{status}),
  fetch:async(url,init)=>{
    deletedObjects.push({url,method:init.method,payload:JSON.parse(init.body)});
    return Response.json([{name:archivedKey}]);
  },
};
vm.runInNewContext(isolatedArchive+'; globalThis.testArchive = lieutenantFiles;',storageContext);
const removeFile=(key)=>storageContext.testArchive(new Request('https://local.test/api/lieutenant-files',{
  method:'DELETE',body:JSON.stringify({key}),
}),{SUPABASE_URL:'https://storage.test',SUPABASE_STORAGE_SECRET:'private-server-secret'});
for(const invalid of ['current.json','lieutenant/current.json','lieutenant/../../current.json',
  'lieutenant/transfers__'+'a'.repeat(32)+'__/wrong.txt']){
  const denied=await removeFile(invalid);
  assert.equal(denied.status,400,'Deletion must reject paths outside one archived file');
}
assert.equal(deletedObjects.length,0,'Invalid archive keys must not reach Supabase');
const successful=await removeFile(archivedKey);
assert.equal(successful.status,200,'Authenticated archive route deletes a single original');
assert.deepEqual(await successful.json(),{deleted:true,key:archivedKey});
assert.equal(deletedObjects.length,1);
assert.equal(deletedObjects[0].method,'DELETE');
assert.ok(deletedObjects[0].url.endsWith('/storage/v1/object/institution-sap'));
assert.deepEqual(deletedObjects[0].payload,{prefixes:[archivedKey]});
assert.ok(screen.includes('async function deleteArchive(file:StoredFile)'));
assert.ok(screen.includes('window.confirm('),'Deletion must require explicit confirmation');
assert.ok(screen.includes('Promise.allSettled('),'Failed reconcile API must not hide archive listing');
assert.ok(fs.readFileSync('worker/index.ts','utf8').includes('downstream.status === 503'),
  'HTML 503 from framework must be translated to actionable JSON');
console.log('PASS: Secure single-file archive deletion, invalid paths, independent archive loading, JSON 503 fallback.');

console.log('Lieutenant parser regressions passed');
