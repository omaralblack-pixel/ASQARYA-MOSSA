import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';

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

console.log('Lieutenant parser regressions passed');
