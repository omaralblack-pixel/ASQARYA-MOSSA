import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';

const cache=new Map();
function loadTs(file){
  file=resolve(file);
  if(cache.has(file))return cache.get(file);
  const exports={}; cache.set(file,exports);
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
const {auditInstitutionTransfers,auditInvoiceQuantities}=loadTs('app/lib/institution-audit.ts');
const {parseReplacementText,previewReplacements,applyReplacements}=loadTs('app/lib/catalog-replacement.ts');

const reference=[
  {code:'11371486',sapCode:'DAR00005',name:'كريمة المؤسسة',sourceName:'Institution',warehouseName:'SAP cream',
   price:1550,invoicePack:20,cartonPieces:20,sapUnit:'Carton',warehouseUnit:'Carton',kgPerPiece:null,active:true},
  {code:'11064245',sapCode:'CHS00033',name:'جبنة المؤسسة',price:800,
   invoicePack:null,cartonPieces:12,sapUnit:'Piece',warehouseUnit:'Piece',kgPerPiece:null,active:true},
];
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const transfer=(number,rows)=>({id:'t-'+number,number,date:'2026-11-09',
  paste:header+'\n'+rows.map(row=>row.join('\t')).join('\n')});
const forward=transfer('2615001',[
  ['DAR00005','cream','2','Carton','001','011'],
  ['FVL99999','foreign item','3','Carton','001','011'],
]);
const reverse=transfer('2615002',[['FVL99999','foreign item','3','Carton','011','001']]);
const partialReverse=transfer('2615003',[['FVL99999','foreign item','1','Carton','011','001']]);

const first=auditInstitutionTransfers([forward],reference);
assert.equal(first.valid,false);
assert.ok(first.issues.some(issue=>issue.kind==='foreign'&&issue.code==='FVL99999'));
assert.equal(auditInstitutionTransfers([forward,partialReverse],reference).valid,false);
assert.equal(auditInstitutionTransfers([forward,reverse],reference).valid,true);
assert.equal(auditInstitutionTransfers([forward,reverse],reference).resolved[0].quantity,3);
assert.equal(auditInstitutionTransfers([forward,transfer('2615004',[['FVL99999','foreign item','3','Carton','011','002']])],reference).valid,false,
 'a different destination warehouse cannot cancel original movement');
assert.equal(auditInstitutionTransfers([forward,transfer('2615005',[['FVL99999','foreign item','3','Piece','011','001']])],reference).valid,false,
 'a different SAP unit cannot cancel original movement');

const invoice=auditInvoiceQuantities([forward,reverse],reference,'11371486\t40','62.000');
assert.equal(invoice.status,'match');
assert.equal(invoice.rows[0].sapPieces,40);
assert.equal(invoice.expectedTotal,62000);
assert.equal(invoice.amountDifference,0);
assert.equal(auditInvoiceQuantities([forward,reverse],reference,'11371486\t39','62.000').status,'difference');
assert.equal(auditInvoiceQuantities([forward,reverse],reference,'11371486\t40','62.001').status,'difference');
assert.equal(auditInvoiceQuantities([forward,reverse],reference,'').status,'missing-invoice');
assert.equal(auditInvoiceQuantities([forward,reverse],reference,'11371487\t40','62.000').status,'review');

const invoiceHeader='رقم المادة\tالكمية';
const invoiceRows=`${invoiceHeader}\n١١٣٧١٤٨٦\t20\n${invoiceHeader}\n11371486\t20`;
assert.equal(auditInvoiceQuantities([forward,reverse],reference,invoiceRows,'62.000').status,'match');
assert.equal(auditInvoiceQuantities([forward,reverse],reference,'Item No.\tQuantity\n11371486\t40','62.000').status,'match');
for(const badRow of ['رقم ناقص 1234\t7','رقم المادة\t7','Item code 1234\t7','\t7','رقم المادة\tالكمية\t7']){
  const audited=auditInvoiceQuantities([forward,reverse],reference,`${invoiceRows}\n\n${badRow}`,'62.000');
  assert.equal(audited.amountDifference,0);
  assert.equal(audited.status,'review',`malformed invoice row must block a match: ${badRow}`);
  assert.match(audited.issues[0],/السطر 6/);
}
assert.equal(auditInvoiceQuantities([forward,reverse],reference,invoiceHeader,'62.000').status,'missing-invoice');

const paste='رقم المادة بالمؤسسة\tItem No.\tItem Description\tحبات الكرتونة\tUoM Name\n11371486\tDAR00005\tSAP changed name\t24\tCarton';
const parsed=parseReplacementText(paste);
assert.equal(parsed.errors.length,0);
assert.equal(parsed.rows.length,1);
const preview=previewReplacements(parsed.rows,reference);
assert.equal(preview[0].status,'ready');
const updated=applyReplacements(reference,preview,[2]);
assert.equal(updated[0].code,'11371486');
assert.equal(updated[0].name,'كريمة المؤسسة');
assert.equal(updated[0].price,1550);
assert.equal(updated[0].sapCode,'DAR00005');
assert.equal(updated[0].cartonPieces,24);
assert.equal(updated[0].warehouseName,'SAP changed name');
assert.equal(updated[1].sapCode,reference[1].sapCode,'unspecified items must never be removed');

const newCode=parseReplacementText('رقم المادة بالمؤسسة\tSAP Code\tشدّة الكرتونة\n11371486\tDAR00999\t36');
const newPreview=previewReplacements(newCode.rows,reference);
assert.equal(newPreview[0].status,'ready');
const changedCode=applyReplacements(reference,newPreview,[2]);
assert.equal(changedCode[0].code,'11371486');
assert.equal(changedCode[0].name,'كريمة المؤسسة');
assert.equal(changedCode[0].sapCode,'DAR00999');
assert.equal(changedCode[0].cartonPieces,36);
const unknown=parseReplacementText('SAP Code\tشدّة الكرتونة\nDAR00999\t24');
assert.equal(previewReplacements(unknown.rows,reference)[0].status,'error','no name-based guessing');
const conflict=parseReplacementText('رقم المادة بالمؤسسة\tSAP Code\n11371486\tCHS00033');
assert.equal(previewReplacements(conflict.rows,reference)[0].status,'error');
const duplicate=parseReplacementText('رقم المادة بالمؤسسة\tSAP Code\tشدّة الكرتونة\n11371486\tDAR00005\t24\n11371486\tDAR00005\t36');
assert.ok(previewReplacements(duplicate.rows,reference).every(row=>row.status==='error'));
console.log('PASS: non-institution SKU alert and exact reverse, invoice pieces and money, preservation of institution item number/name/price, guarded SAP replacement.');

const {initialAuditCatalog,catalogAuditReference,importAuditSap,importAuditInstitution,validateAuditCatalog}=loadTs('app/lib/audit-catalog.ts');
const requireFromHere=createRequire(import.meta.url);
const defaults=requireFromHere('../app/reference.json');
const initialCatalog=initialAuditCatalog(defaults);
assert.ok(validateAuditCatalog(initialCatalog));
assert.equal(Object.keys(requireFromHere('../app/lib/audit-catalog-seed.json')).length,81);
const institutionCatalog=importAuditInstitution('رقم المادة بالمؤسسة\tتسمية المؤسسة\n01234567\tبطاطا المؤسسة',initialCatalog);
const bulk=importAuditSap('Item No.\tItem Description\tQuantity\tUoM Code\tInstitution Code\nFVL99991\tبطاطا SAP 10*1 KG\t1\tCarton\t01234567\n\t\t\t\t',institutionCatalog);
assert.equal(bulk.sap.find(row=>row.code==='FVL99991').pack,10);
assert.equal(bulk.institution.find(row=>row.code==='01234567').name,'بطاطا المؤسسة');
const auditRef=catalogAuditReference(bulk);
const auditedNew=auditInvoiceQuantities([transfer('2615010',[['FVL99991','بطاطا SAP','2','Carton','009','011']])],auditRef,'01234567\t20');
assert.equal(auditedNew.status,'match');
assert.equal(auditedNew.rows.find(row=>row.code==='01234567').sapPieces,20);
assert.throws(()=>importAuditSap('FVL99991\tبطاطا SAP\tCarton\t0',bulk),/السطر/);
assert.throws(()=>importAuditSap('FVL99991\tبطاطا SAP\tCarton\t10\t\t99999999',bulk),/غير موجود/);
assert.throws(()=>importAuditInstitution('01234567\tبطاطا\n01234567\tتكرار',bulk),/السطر 2/);
console.log('PASS: bulk audit catalogs, linked aliases and unit conversion.');


// Daily soldier: exact blue-invoice date, linked transfer lines, and hard final-match gate.
const {auditDraftWithSoldier,dailySoldierRows}=loadTs('app/lib/daily-soldier.ts');
const soldierCatalog={
  institution:[{code:'11371486',name:'كريمة المؤسسة',price:1550},
    {code:'11064245',name:'جبنة المؤسسة',price:800}],
  sap:[{code:'DAR00005',name:'كريمة SAP',unit:'Carton',pack:20,kg:null,institutionCode:'11371486'},
    {code:'CHS00033',name:'جبنة SAP',unit:'Piece',pack:12,kg:null,institutionCode:'11064245'}],
};
const auditInv=(id,number,date,amount,auditLines,complete=true)=>({
  id,number,date,amount,auditLines,complete,quantities:{},
});
const cleanForward=transfer('2618001',[['DAR00005','cream','2','Carton','001','011']]);
const draftForSoldier={
  id:'soldier-one',branch:'الجيزة',driver:'',date:'2026-11-10',mode:'manual',
  transfers:[cleanForward],notes:'',
  invoices:[auditInv('paper-one','2622000001','2026-11-01','62.000','11371486\t40')],
};
assert.equal(auditDraftWithSoldier(draftForSoldier,soldierCatalog).allMatched,true);
const day=dailySoldierRows([{id:'soldier-one',branch:'الجيزة',payload:JSON.stringify(draftForSoldier)}],
  soldierCatalog,'1.11.2026');
assert.equal(day.date,'2026-11-01');
assert.equal(day.counts.total,1);
assert.equal(day.counts.matched,1);
assert.equal(dailySoldierRows([{id:'soldier-one',branch:'الجيزة',payload:JSON.stringify(draftForSoldier)}],
  soldierCatalog,'09.11.2026').counts.total,0,
  'Invoice dates govern the daily table, not SAP transfer dates.');
assert.equal(auditDraftWithSoldier({...draftForSoldier,invoices:[
  {...draftForSoldier.invoices[0],auditLines:''}]},soldierCatalog).invoices[0].status,'review',
  'A perfectly matching amount cannot substitute for missing blue-invoice item quantities.');
assert.equal(auditDraftWithSoldier({...draftForSoldier,invoices:[
  {...draftForSoldier.invoices[0],auditLines:'11371486\t39'}]},soldierCatalog).invoices[0].status,'difference');
assert.equal(auditDraftWithSoldier({...draftForSoldier,invoices:[
  {...draftForSoldier.invoices[0],amount:'62.001'}]},soldierCatalog).invoices[0].status,'difference');
assert.equal(auditDraftWithSoldier({...draftForSoldier,transfers:[forward]},soldierCatalog).invoices[0].status,'review',
  'Unmatched non-institution movement must block approval.');
assert.equal(auditDraftWithSoldier({...draftForSoldier,transfers:[forward,reverse]},soldierCatalog).allMatched,true,
  'A fully reversed non-institution movement may be ignored in net item quantities.');
assert.equal(auditDraftWithSoldier({...draftForSoldier,transfers:[forward,partialReverse]},soldierCatalog).allMatched,false);
const withoutPack={...soldierCatalog,sap:soldierCatalog.sap.map(item=>item.code==='DAR00005'?{...item,pack:null}:item)};
assert.equal(auditDraftWithSoldier(draftForSoldier,withoutPack).invoices[0].status,'review');
const twoInvoices={
  ...draftForSoldier,
  transfers:[cleanForward,transfer('2618002',[['CHS00033','cheese','12','Piece','002','011']])],
  invoices:[
    auditInv('p1','2622000001','2026-11-01','62.000','11371486\t40'),
    auditInv('p2','2622000002','2026-11-02','9.600','11064245\t12'),
  ],
  pages:{'i:11371486':'1','i:11064245':'2'},
};
assert.equal(auditDraftWithSoldier(twoInvoices,soldierCatalog).allMatched,true);
assert.equal(auditDraftWithSoldier({...twoInvoices,pages:{'i:11371486':'1'}},soldierCatalog).allMatched,false);
const twoDayRows=dailySoldierRows([{id:'multi',branch:'الجيزة',payload:JSON.stringify(twoInvoices)}],
  soldierCatalog,'2026-11-02');
assert.equal(twoDayRows.counts.total,1);
assert.equal(twoDayRows.rows[0].invoice.number,'2622000002');
assert.equal(twoDayRows.rows[0].invoice.transferNumbers[0],'2618002');
console.log('PASS: daily soldier uses blue-invoice date and blocks missing evidence, quantity/amount mismatches, missing pack and unassigned lines.');

const {includeOfficialInstitution2026}=loadTs('app/lib/audit-catalog.ts');
const official2026=requireFromHere('../app/lib/official-institution-2026.json');
assert.equal(Object.keys(official2026).length,90,'Official PDF must retain all 90 institution items.');
const migrated=includeOfficialInstitution2026({...initialCatalog,officialSeedVersion:undefined});
assert.equal(migrated.officialSeedVersion,1);
assert.equal(migrated.institution.some(item=>item.code==='11356453'),true,'Missing official institution items must be added.');
assert.equal(migrated.sap.length,initialCatalog.sap.length,'Importing institution names must not rewrite SAP mappings or carton packs.');
assert.equal(migrated.institution.find(item=>item.code==='11356453')?.price,990);
const custom={...initialCatalog,officialSeedVersion:undefined,
  institution:initialCatalog.institution.map(item=>item.code==='11062673'?{...item,name:'Custom approved name'}:item)};
assert.equal(includeOfficialInstitution2026(custom).institution.find(item=>item.code==='11062673')?.name,'Custom approved name');
const removed={...migrated,institution:migrated.institution.filter(item=>item.code!=='11356453')};
assert.equal(includeOfficialInstitution2026(removed).institution.some(item=>item.code==='11356453'),false,
  'Once imported, a user deletion must not be undone by reopening the catalog.');
console.log('PASS: official 2026 PDF seed adds missing institution codes once without changing saved edits or SAP carton sizes.');


// Explicit user-confirmed SAP links: additive, collision-safe and not silently "Piece".
const {includeConfirmedSapLinks,confirmedSapLinkConflicts}=loadTs('app/lib/audit-catalog.ts');
const confirmedCatalog=initialAuditCatalog(defaults);
const safePairs=[
 ['CHS00051','11375811'],['CFC00003','11356453'],['CFC00005','11356457'],
 ['CFC00012','11356459'],['CFC00016','11356458'],['CFC00084','11356460'],
 ['FVL00368','11286286'],['FVL00389','94233343'],['FVL00246','11316287'],
];
for(const [code,institutionCode] of safePairs){
 const row=confirmedCatalog.sap.find(row=>row.code===code);
 assert.ok(row,'confirmed SAP item must appear: '+code);
 assert.equal(row.institutionCode,institutionCode);
 assert.equal(row.unit,'','Unit unknown until official SAP paste');
 assert.equal(row.pack,null,'Institution carton pack must not be assumed to be SAP pack');
}
const collisionPairs=[
 ['FVL00016','11367181','94234612'],
 ['CFC00006','11356477','11356455'],
 ['DAR00032','11770182','11770183'],
 ['CHS00005','11377161','94233341'],
];
const collisions=confirmedSapLinkConflicts(confirmedCatalog);
for(const [code,current,requested] of collisionPairs){
 const row=confirmedCatalog.sap.find(row=>row.code===code);
 assert.equal(row?.institutionCode,current,'Existing SAP primary institution number must be preserved: '+code);
 assert.deepEqual(row?.institutionAliases,[requested],
  'The confirmed second institution code must be available for invoice-specific selection: '+code);
 assert.equal(collisions.some(row=>row.code===code),false,'Dual codes are not unresolved conflicts');
}
assert.equal(confirmedCatalog.confirmedLinksVersion,1);
const withoutMarker={...confirmedCatalog,confirmedLinksVersion:undefined};
assert.equal(includeConfirmedSapLinks(withoutMarker).sap.length,confirmedCatalog.sap.length,
  'Migrating the same confirmation batch must not duplicate SAP codes.');
assert.equal(includeConfirmedSapLinks(confirmedCatalog),confirmedCatalog,
  'Applied migration must not re-create a user-deleted mapping.');
const unknownUnitAudit=auditInstitutionTransfers([
 transfer('2618111',[['CFC00003','farfalle','1','Piece','001','011']])
],catalogAuditReference(confirmedCatalog));
assert.equal(unknownUnitAudit.valid,false,
  'Link is confirmed but unknown SAP unit must block final approval');
assert.match(unknownUnitAudit.issues[0]?.message||'',/وحدة SAP/);
const importedUnitCatalog=importAuditSap(
 'Item No.\tItem Description\tUoM Code\tCarton Pieces\nCFC00003\tFARFALLE 24x500G\tCarton\t24',
 confirmedCatalog
);
assert.equal(importedUnitCatalog.sap.find(row=>row.code==='CFC00003')?.institutionCode,'11356453');
assert.equal(auditInstitutionTransfers([
 transfer('2618112',[['CFC00003','farfalle','1','Carton','001','011']])
],catalogAuditReference(importedUnitCatalog)).valid,true);
console.log('PASS: user-confirmed mapping imports without SAP unit assumptions; collisions preserve historical codes; missing UoM blocks approval.');


// A real invoice must choose which of the two institution numbers is printed,
// and the choice is scoped to that invoice, never to the shared SAP master.
const {catalogAuditReferenceForInvoice,sharedInstitutionOptions,includeSharedInstitutionNumbers}=loadTs('app/lib/audit-catalog.ts');
assert.equal(sharedInstitutionOptions(confirmedCatalog).length,4);
assert.equal(validateAuditCatalog(confirmedCatalog),true);
const sharedFvl=confirmedCatalog.sap.find(row=>row.code==='FVL00016');
assert.equal(sharedFvl.institutionCode,'11367181');
assert.deepEqual(sharedFvl.institutionAliases,['94234612']);
const singleShared=transfer('2618200',[['FVL00016','mango 1kg','1','Carton','001','011']]);
const sharedDraft={
 ...draftForSoldier,transfers:[singleShared],
 invoices:[auditInv('p-mango','2622200000','2026-11-01','31.840','94234612\t16')],
};
const noChoice=auditDraftWithSoldier(sharedDraft,confirmedCatalog);
assert.equal(noChoice.invoices[0].status,'review');
assert.deepEqual(noChoice.invoices[0].sharedCodes[0].codes.map(x=>x.code),
 ['11367181','94234612']);
assert.match(noChoice.invoices[0].reasons.join('|'),/يوجد صنف برقمين للمؤسسة/);
const paperOnly=auditDraftWithSoldier({...sharedDraft,transfers:[]},confirmedCatalog);
assert.equal(paperOnly.invoices[0].sharedCodes.some(row=>row.sapCode==='FVL00016'),true,
 'A dual-number warning must also appear when the item is on the paper but SAP transfer is missing.');
assert.equal(paperOnly.allMatched,false);
const withChoice={...sharedDraft,invoices:[{...sharedDraft.invoices[0],
 sapInstitutionChoices:{FVL00016:'94234612'}}]};
assert.equal(auditDraftWithSoldier(withChoice,confirmedCatalog).invoices[0].status,'match');
assert.equal(auditDraftWithSoldier(withChoice,confirmedCatalog).allMatched,true);
assert.equal(catalogAuditReferenceForInvoice(confirmedCatalog,{FVL00016:'94234612'})
 .find(row=>row.code==='94234612').sapCode,'FVL00016');
assert.equal(catalogAuditReference(confirmedCatalog).find(row=>row.code==='11367181').sapCode,'FVL00016',
 'The original mapping must not be overwritten by invoice choice');
assert.equal(auditDraftWithSoldier({...sharedDraft,invoices:[
 {...sharedDraft.invoices[0],sapInstitutionChoices:{FVL00016:'11367181'}}]},confirmedCatalog).allMatched,false,
 'Chosen number absent from pasted blue invoice must not pass');
assert.equal(auditDraftWithSoldier({...sharedDraft,invoices:[
 {...sharedDraft.invoices[0],sapInstitutionChoices:{FVL00016:'99999999'}}]},confirmedCatalog).allMatched,false,
 'Unapproved institution alias must not pass');
assert.equal(auditDraftWithSoldier({...withChoice,invoices:[
 {...withChoice.invoices[0],auditLines:'94234612\t16\n11367181\t16'}]},confirmedCatalog).allMatched,false,
 'Both numbers on the same paper must not be silently collapsed');
const secondPaper={...sharedDraft,invoices:[
 {...sharedDraft.invoices[0],number:'2622200001',auditLines:'11367181\t16',
   sapInstitutionChoices:{FVL00016:'11367181'}}]};
const withBothPrices={...confirmedCatalog,
 institution:confirmedCatalog.institution.map(row=>row.code==='11367181'?{...row,price:1990}:row)};
assert.equal(auditDraftWithSoldier(secondPaper,withBothPrices).allMatched,true,
 'A distinct invoice can approve the original institution number');
assert.equal(auditDraftWithSoldier(withChoice,withBothPrices).allMatched,true,
 'Previous invoice can separately approve the alternate number');
const dailyShared=dailySoldierRows([
 {id:'p1',branch:'الجيزة',payload:JSON.stringify(secondPaper)},
 {id:'p2',branch:'الجيزة',payload:JSON.stringify(withChoice)},
],withBothPrices,'2026-11-01');
assert.equal(dailyShared.counts.matched,2);
assert.equal(dailyShared.rows.length,2);
const noRepeat=includeSharedInstitutionNumbers({...confirmedCatalog,sharedInstitutionVersion:undefined});
assert.equal(noRepeat.sap.find(row=>row.code==='FVL00016').institutionAliases.length,1);
assert.equal(includeSharedInstitutionNumbers(confirmedCatalog),confirmedCatalog,
 'Reopening a catalog must not duplicate the alternative item code');
console.log('PASS: all four duplicate institution numbers; explicit per-invoice choices, individual prices and cross-invoice isolation.');


// Jundi smart invoice-page sorting: link actual SAP rows to the exact blue invoices,
// never treat a price-only match or ambiguous transfer as proof.
const {sortSoldierInvoicePages,soldierLineKey}=loadTs('app/lib/soldier-page-sort.ts');
const {evaluateSerial}=loadTs('app/lib/serial-soldier.ts');
const threeCatalog={
 institution:[{code:'11371486',name:'cream',price:1550},
   {code:'11064245',name:'cheese',price:800},
   {code:'01234567',name:'potatoes',price:900}],
 sap:[{code:'DAR00005',name:'cream',unit:'Carton',pack:20,kg:null,institutionCode:'11371486'},
   {code:'CHS00033',name:'cheese',unit:'Piece',pack:12,kg:null,institutionCode:'11064245'},
   {code:'FVL99991',name:'fries',unit:'Carton',pack:10,kg:null,institutionCode:'01234567'}],
};
const sameTransfer=transfer('2618801',[
 ['DAR00005','cream','2','Carton','001','011'],
 ['CHS00033','cheese','12','Piece','002','011'],
 ['FVL99991','fries','1','Carton','009','011'],
]);
const threeInvoices={...draftForSoldier,transfers:[sameTransfer],pages:{},
 invoices:[
   auditInv('pg1','26288001','2026-11-12','62.000','11371486\t40'),
   auditInv('pg2','26288002','2026-11-12','9.600','11064245\t12'),
   auditInv('pg3','26288003','2026-11-12','9.000','01234567\t10'),
 ]};
const classified=sortSoldierInvoicePages(threeInvoices,threeCatalog);
assert.equal(classified.assigned,3);
assert.equal(classified.split,0);
assert.equal(classified.unresolved.length,0);
assert.deepEqual(classified.pageCounts,[1,1,1]);
assert.deepEqual(classified.draft.pages,{'i:11371486':'1','i:11064245':'2','i:01234567':'3'});
assert.equal(auditDraftWithSoldier(classified.draft,threeCatalog).allMatched,true);
assert.deepEqual(classified.lines.map(line=>line.page),[1,2,3]);
assert.deepEqual(classified.lines.map(line=>line.value),[62000,9600,9000]);
const stored={...classified.draft,referenceSnapshot:catalogAuditReference(threeCatalog),
 summary:{status:'match'}};
const serial=evaluateSerial(
 threeInvoices.invoices.map((invoice,i)=>({row:i+2,number:invoice.number,amount:invoice.amount,date:invoice.date})),
 [{id:'sorted-record',branch:'الجيزة',status:'match',payload:JSON.stringify(stored)}]
);
assert.deepEqual(serial.blockers,[]);
assert.equal(serial.count.received,3);
for(const row of serial.rows)assert.deepEqual(row.transfers.map(t=>t.number),['2618801']);
assert.equal(serial.rows[0].transfers[0].kind,'adjustment',
 'Mixed SAP warehouse directions must be adjustment, not falsely classified as main or dry.');

const oneLine=transfer('2618802',[['DAR00005','cream','2','Carton','001','011']]);
const splitDraft={...threeInvoices,transfers:[oneLine],pages:{},
 invoices:[auditInv('q1','26288004','2026-11-12','31.000','11371486\t20'),
   auditInv('q2','26288005','2026-11-12','31.000','11371486\t20')]};
const splitSort=sortSoldierInvoicePages(splitDraft,threeCatalog);
assert.equal(splitSort.assigned,1);
assert.equal(splitSort.split,1);
assert.equal(splitSort.unresolved.length,0);
assert.deepEqual(Object.values(splitSort.draft.soldierLineAllocations)[0],{'1':20,'2':20});
assert.equal(auditDraftWithSoldier(splitSort.draft,threeCatalog).allMatched,true);
const splitSerial=evaluateSerial(
 splitDraft.invoices.map((invoice,i)=>({row:i+2,number:invoice.number,amount:invoice.amount,date:invoice.date})),
 [{id:'split-one',branch:'الجيزة',status:'match',
   payload:JSON.stringify({...splitSort.draft,referenceSnapshot:catalogAuditReference(threeCatalog),summary:{status:'match'}})}]);
assert.equal(splitSerial.count.received,2);
assert.deepEqual(splitSerial.blockers,[]);
assert.ok(splitSerial.rows.every(row=>row.transfers[0]?.number==='2618802'));

const firstTrans=transfer('2618803',[['DAR00005','cream','1','Carton','001','011']]);
const nextTrans=transfer('2618804',[['DAR00005','cream','1','Carton','001','011']]);
const uncertain={...splitDraft,transfers:[firstTrans,nextTrans]};
const uncertainSort=sortSoldierInvoicePages(uncertain,threeCatalog);
assert.equal(uncertainSort.unresolved.length,2,'Two different transfer numbers with identical lines are genuinely ambiguous.');
assert.equal(auditDraftWithSoldier(uncertainSort.draft,threeCatalog).allMatched,false);
const keys=uncertainSort.unresolved.map(row=>row.key);
const settled={...uncertainSort.draft,
 soldierLineAllocations:{[keys[0]]:{'1':20},[keys[1]]:{'2':20}},
 soldierManualLineKeys:keys};
assert.equal(sortSoldierInvoicePages(settled,threeCatalog).unresolved.length,0);
assert.equal(auditDraftWithSoldier(settled,threeCatalog).allMatched,true);
const classifiedSerial=evaluateSerial(
 uncertain.invoices.map((invoice,i)=>({row:i+2,number:invoice.number,amount:invoice.amount,date:invoice.date})),
 [{id:'separate',branch:'الجيزة',status:'match',
   payload:JSON.stringify({...settled,referenceSnapshot:catalogAuditReference(threeCatalog),summary:{status:'match'}})}]);
assert.deepEqual(classifiedSerial.blockers,[]);
assert.deepEqual(classifiedSerial.rows.map(r=>r.transfers[0]?.number),['2618803','2618804']);
const fakePartial={...settled,soldierLineAllocations:{
 ...settled.soldierLineAllocations,[keys[0]]:{'1':10}}};
assert.equal(auditDraftWithSoldier(fakePartial,threeCatalog).allMatched,false,
 'A forged or partial line distribution must block final match.');
const invalidManualResort=sortSoldierInvoicePages(fakePartial,threeCatalog);
assert.ok(invalidManualResort.unresolved.some(issue=>issue.key===keys[0]),
 'An outdated human-approved quantity must raise a review notice.');
assert.equal(invalidManualResort.draft.soldierLineAllocations[keys[0]],undefined,
 'Automatic sorting may not silently overwrite an outdated manual allocation.');

const invalidSerial=evaluateSerial(
 [{row:2,number:uncertain.invoices[0].number,amount:uncertain.invoices[0].amount,date:'2026-11-12'}],
 [{id:'partial',branch:'الجيزة',status:'match',payload:JSON.stringify({
 ...fakePartial,referenceSnapshot:catalogAuditReference(threeCatalog),summary:{status:'match'}})}]);
assert.ok(invalidSerial.blockers.some(line=>line.includes('لا يمكن ربط جميع بنوده')),
 'A incomplete line allocation can never be silently exported as a known transfer.');
const reverseSame=transfer('2618805',[['DAR00005','cream','1','Carton','011','001']]);
const reverseDraft={...draftForSoldier,transfers:[oneLine,reverseSame],
 invoices:[auditInv('rev','26288006','2026-11-12','31.000','11371486\t20')]};
const reverseSort=sortSoldierInvoicePages(reverseDraft,threeCatalog);
assert.equal(reverseSort.unresolved.length,0);
assert.equal(reverseSort.assigned,2);
assert.equal(auditDraftWithSoldier(reverseSort.draft,threeCatalog).allMatched,true);
assert.equal(reverseSort.lines.reduce((sum,line)=>sum+line.pieces,0),20);
assert.equal(sortSoldierInvoicePages({...splitDraft,invoices:splitDraft.invoices.map(row=>({
 ...row,auditLines:'',quantities:{}}))},threeCatalog).assigned,0,
 'No blue invoice item evidence = no automatic classification.');
console.log('PASS: three-page sorting, per-page prices, split transfer rows, user-approved ambiguity, serial mapping and reverse entries.');
