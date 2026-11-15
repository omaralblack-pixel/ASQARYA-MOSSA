import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../app/lib/aqaba.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const p=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
// Ensure the three SAP query generators are alias-free and keep inventory coverage.
const querySource=fs.readFileSync(new URL('../app/lib/aqaba-query.ts',import.meta.url),'utf8')
  .replace("from './aqaba'", "from 'data:text/javascript;base64,"+Buffer.from(js).toString('base64')+"'");
const queryJS=ts.transpileModule(querySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const aqabaQueries=await import('data:text/javascript;base64,'+Buffer.from(queryJS).toString('base64'));
const inventorySQL=aqabaQueries.aqabaInventoryQuery('2026-11-01','2026-11-15');
const transferSQL=aqabaQueries.transferAqabaQuery('2026-11-01','2026-11-15');
const officialSQL=aqabaQueries.officialAqabaQuery('2026-11-01','2026-11-15');
assert.ok(inventorySQL.includes('FROM "OINM"'));
assert.ok(inventorySQL.includes(`"OINM"."Warehouse" = '011'`));
assert.ok(inventorySQL.includes(`"OINM"."DocDate" BETWEEN TO_DATE('2026-11-01'`));
assert.ok(!inventorySQL.includes('M."')&&!inventorySQL.includes('FROM "OINM" M'));
assert.ok(transferSQL.includes('FROM "OWTR"')&&transferSQL.includes('INNER JOIN "WTR1" ON "OWTR"."DocEntry" = "WTR1"."DocEntry"'));
assert.ok(transferSQL.includes(`"WTR1"."FromWhsCod"='011' OR "WTR1"."WhsCode"='011'`));
assert.ok(transferSQL.includes(`"OWTR"."DocDate" BETWEEN TO_DATE('2026-11-01'`));
assert.ok(!transferSQL.includes('H."')&&!transferSQL.includes('L."')&&!transferSQL.includes('FROM "OWTR" H')&&!transferSQL.includes('JOIN "WTR1" L'));
for(const table of ['OINV','ORIN','ODLN','ORDN'])assert.ok(officialSQL.includes('FROM "'+table+'"'));
for(const table of ['INV1','RIN1','DLN1','RDN1'])assert.ok(officialSQL.includes('INNER JOIN "'+table+'" ON '));
assert.ok(!officialSQL.includes('H."')&&!officialSQL.includes('L."'));
assert.ok(officialSQL.includes('UNION ALL')&&!officialSQL.includes(`"CANCELED" = 'N'`));
assert.throws(()=>aqabaQueries.aqabaInventoryQuery('2026-11-16','2026-11-15'),/فترة غير صحيحة/);
console.log('PASS: Aqaba SAP SQL is alias-free and keeps inventory, directions, dates and cancellations.');
const heading=['نوع المستند','رقم الفاتورة','DocEntry','التاريخ','رقم الزبون','رقم السطر','المستودع','كود الصنف','اسم الصنف','الوحدة','الكمية','سعر الوحدة','القيمة قبل الضريبة','الضريبة','حالة الإلغاء','نوع المستند المرجعي','BaseEntry','BaseLine','رقم المستند المرجعي'].join('\t');
const line=(kind,number,row,qty,canceled,customer='C0006751')=>
 [kind,number,number,'2026-11-03',customer,row,'011','CHS00561','جبنة فيتا','Piece',qty,0.313,qty*0.313,0,canceled,-1,'','',''].join('\t');
const read=p.readAqabaOfficial([heading,line('IN','260063818',1,600,'Y'),line('IN','260063820',1,600,'C'),line('CN','260063821',1,20,'N')].join('\n'));
assert.equal(read.items.length,3);
assert.equal(read.items[0].canceled,'Y');
assert.equal(read.items[1].canceled,'C');
assert.equal(read.items[2].kind,'CN');
assert.equal(read.items[0].inventoryEffect,'unverified');
const denied=p.readAqabaOfficial([heading,line('IN','12345678',1,10,'N','C0001234')].join('\n'));
assert.equal(denied.items.length,0);
assert.ok(denied.issues.some(x=>x.includes('زبون غير العقبة')));
const blueHeading=['رقم الفاتورة الزرقاء','التاريخ','كود SAP','اسم الصنف','الكمية','الوحدة','السعر','أرقام الفواتير الرسمية','أرقام الترحيلات'].join('\t');
const blueRow=['2650710367','2026-11-03','CHS00561','جبنة فيتا','600','Piece','0.313','260063818','2615754'].join('\t');
const blue=p.readAqabaBlue([blueHeading,blueRow].join('\n'));
assert.equal(blue.items.length,1);
assert.equal(blue.items[0].price,0.313);
assert.equal(blue.items[0].transferNumbers[0],'2615754');
const compare=p.compareAqaba(blue.items,read.items);
assert.ok(compare[0].issues.some(x=>x.includes('إلغاء')));
const nonCanceled=p.readAqabaOfficial([heading,line('IN','260063818',1,599,'N')].join('\n'));
const wrong=p.compareAqaba(blue.items,nonCanceled.items);
assert.equal(wrong[0].differences[0].difference,1);
const correct=p.readAqabaOfficial([heading,line('IN','260063818',1,600,'N')].join('\n'));
const matched=p.compareAqaba(blue.items,correct.items);
assert.equal(matched[0].differences.length,0);
assert.equal(matched[0].officialNumbers[0],'260063818');
assert.equal(matched[0].transferNumbers[0],'2615754');

const transferHeader=['رقم الترحيل','DocEntry','التاريخ','Remarks','حالة الإلغاء','رقم السطر','كود الصنف','اسم الصنف','الوحدة','الكمية','من المستودع','إلى المستودع'].join('\t');
const tranRow=(i,item,qty)=>['2615754','89101','2026-11-03','مؤسسة العقبة','N',i,item,'بنود','Piece',qty,'001','011'].join('\t');
const transfer=p.readAqabaTransfers([transferHeader,tranRow(1,'CHS00561',600)].join('\n'));
assert.equal(transfer.items.length,1);
assert.equal(transfer.items[0].classified,'aqaba-remark');
const secondBlue=p.readAqabaBlue([blueHeading,
 ['2650710368','2026-11-03','CHS00561','صنف','0','Piece','0.313','260063818','2615754'].join('\t')].join('\n'));
const group=p.reviewAqabaTransfers([...blue.items,...secondBlue.items],transfer.items);
assert.equal(group.length,1);
assert.equal(group[0].blueInvoices.length,2);
assert.equal(group[0].differences.length,0);
const oinmHeader=['معرف حركة المخزون','التاريخ','نوع حركة SAP','DocEntry','رقم المستند','رقم السطر','كود الصنف','اسم الصنف','المستودع','الوارد','الصادر','رقم الزبون'].join('\t');
const incoming=['12345','2026-11-03','67','89101','2615754','0','CHS00561','جبنة','011','600','0',''].join('\t');
const outgoing=['12346','2026-11-03','13','260063818','260063818','0','CHS00561','جبنة','011','0','600','C0006751'].join('\t');
const journal=p.readAqabaJournal([oinmHeader,incoming,outgoing].join('\n'));
assert.equal(journal.items.length,2);
const stock=p.auditAqabaJournal(journal.items,correct.items,transfer.items);
assert.equal(stock.physical.net,0);
assert.equal(stock.aqabaEvidence.incoming,600);
assert.equal(stock.aqabaEvidence.outgoing,600);


const seedSource=fs.readFileSync(new URL('../app/lib/aqaba-blue-seed.ts',import.meta.url),'utf8');
const seedJS=ts.transpileModule(seedSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const priceSeed=await import('data:text/javascript;base64,'+Buffer.from(seedJS).toString('base64'));
const seedRows=priceSeed.aqabaBlueSeed();
assert.equal(seedRows.length,52);
const aqabaRouteSource=fs.readFileSync(new URL('../app/api/aqaba/route.ts',import.meta.url),'utf8');
assert.ok(aqabaRouteSource.includes('const rowsPerStatement=20;'),
 'Aqaba seed SQL must batch at most 20 five-column rows under D1 100-binding limit');
assert.ok(aqabaRouteSource.includes('db().batch(seedStatements)'),
 'Aqaba prices must be written through an atomic multi-statement batch');
assert.ok(aqabaRouteSource.includes('SELECT COUNT(*) AS count FROM aqaba_blue WHERE id IN'),
 'Verify persisted seed keys via a read-back query after initialization');
assert.ok(aqabaRouteSource.includes('INSERT OR IGNORE INTO aqaba_blue'),
 'Auto-seeding must never overwrite manually corrected Aqaba prices');
assert.ok(seedRows.length*5>100&&Math.ceil(seedRows.length/20)===3&&20*5<=100,
 '52 blue-invoice prices need three inserts with no more than 100 bound parameters per SQL');
const aqabaScreenSource=fs.readFileSync(new URL('../app/reconciliation/AqabaWorkspace.tsx',import.meta.url),'utf8');
assert.ok(aqabaScreenSource.includes('المحفوظ فعلًا بقاعدة بيانات العقبة'));
assert.ok(aqabaScreenSource.includes('2650710369')&&aqabaScreenSource.includes('0.350'),
 'Use actual recorded Aqaba seed example rather than misleading placeholder price');

assert.equal(new Set(seedRows.map(row=>row.code)).size,52);
const totals=priceSeed.aqabaSeedTotals();
assert.equal(totals.get('2650710367'),651930);
assert.equal(totals.get('2650710368'),2737700);
assert.equal(totals.get('2650710369'),823960);
const persisted=priceSeed.aqabaSeedInvoiceLines([{sapCode:'CHS00561',warehouseName:'جبنة فيتا جولد رودس'}]);
assert.equal(persisted.length,52);
assert.equal(persisted.find(row=>row.item==='CHS00561').price,0.35);
assert.equal(persisted.find(row=>row.item==='CHS00561').description,'جبنة فيتا جولد رودس');
assert.equal(persisted.find(row=>row.item==='FVL00043').quantity,200);
assert.equal(persisted.find(row=>row.item==='FOD00064').sourceEstimatedPack,40);
assert.ok(persisted.every(row=>row.transferNumbers.join(',')==='2615754'));
assert.ok(persisted.every(row=>row.officialNumbers.length===0));
const stable=p.readAqabaBlue([blueHeading,blueRow].join('\n'));
assert.equal(stable.items[0].key,'2650710367|CHS00561|1');

console.log('Aqaba parser and cancellation handling passed');
