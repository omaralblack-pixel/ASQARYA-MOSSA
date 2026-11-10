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
