import {env} from 'cloudflare:workers';
import defaults from '../../reference.json';
import schemaStatements from '../../lib/reconciliation-schema.json';
import branches from '../../branches.json';
import drivers from '../../drivers.json';
import {reconcile,withInvoiceDates,groupReference,sapReferences,documentNo,dateValue,transferNumbers,type Draft,type Item} from '../../lib/reconcile';
import {prepareGroupMerge} from '../../lib/prepare-merge';
export const dynamic='force-dynamic';
const json=(v:any,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const db=()=>{if(!env.DB)throw Error('قاعدة البيانات غير متاحة');return env.DB};
async function refs():Promise<Item[]>{const r=await db().prepare('SELECT value FROM settings WHERE key=?').bind('reconciliationReference').first();return r?JSON.parse(String(r.value)):defaults as Item[]}
// Initialize only missing tables on standalone Cloudflare deployments.
let schemaReady:Promise<unknown>|undefined;
function ensureSchema(){return schemaReady??=db().batch(schemaStatements.map(sql=>db().prepare(sql))).catch(error=>{schemaReady=undefined;throw error})}
export async function GET(req:Request){try{await ensureSchema();const u=new URL(req.url);if(u.searchParams.has('id')){const r=await db().prepare('SELECT * FROM reconciliations WHERE id=?').bind(u.searchParams.get('id')).first();return r?json({record:r}):json({error:'السجل غير موجود'},404)}if(u.searchParams.has('transfer')){const number=(u.searchParams.get('transfer')||'').trim();if(!/^\d{4,20}$/.test(number))return json({error:'رقم الترحيل غير صالح'},400);const found=await db().prepare("SELECT r.id,r.payload FROM reconciliations r WHERE EXISTS (SELECT 1 FROM json_each(r.payload,'$.transfers') t WHERE trim(CAST(json_extract(t.value,'$.number') AS TEXT))=?) ORDER BY r.updated DESC LIMIT 2").bind(number).all();const matches=(found.results||[]) as any[];if(matches.length>1)return json({error:'الترحيل موجود في أكثر من مجموعة محفوظة؛ افتح المجموعة الصحيحة من السجل لتجنب التكرار.'},409);if(!matches.length)return json({error:'رقم الترحيل غير موجود في المجموعات المستوردة والمحفوطة.'},404);const record=JSON.parse(String(matches[0].payload)) as Draft;const transfer=record.transfers.find(t=>String(t.number).trim()===number);return transfer?json({transfer,invoiceNumbers:record.invoices.map(i=>i.number).filter(Boolean),recordId:matches[0].id}):json({error:'بيانات الترحيل غير متاحة'},404)} if(u.searchParams.has('export')){const r=await db().prepare('SELECT id,branch,doc_date,payload FROM reconciliations ORDER BY updated DESC').all();return json({records:r.results})} if(u.searchParams.has('records')){const r=await db().prepare(`SELECT id,branch,driver,doc_date,status,created,updated,version,json_object('summary',json(json_extract(payload,'$.summary')),'transfers',json((SELECT json_group_array(json_object('number',json_extract(value,'$.number'),'date',json_extract(value,'$.date'))) FROM json_each(payload,'$.transfers'))),'invoices',json((SELECT json_group_array(json_object('number',json_extract(value,'$.number'),'complete',json(CASE WHEN json_extract(value,'$.complete')=1 THEN 'true' ELSE 'false' END),'date',json_extract(value,'$.date'),'amount',json_extract(value,'$.amount'))) FROM json_each(payload,'$.invoices')))) AS payload FROM reconciliations ORDER BY updated DESC`).all();return json({records:r.results})}const settings=await db().prepare("SELECT key,value FROM settings WHERE key IN ('branches','drivers')").all();const shared=Object.fromEntries((settings.results as any[]).map(r=>[r.key,JSON.parse(r.value)]));return json({reference:await refs(),branches:shared.branches||branches,drivers:shared.drivers||drivers})}catch{return json({error:'تعذّر تحميل البيانات. أعد المحاولة.'},500)}}
export async function POST(req:Request){try{if(req.headers.get('origin')!==new URL(req.url).origin)return json({error:'طلب غير مسموح'},403);if(Number(req.headers.get('content-length')||0)>3000000)return json({error:'حجم البيانات كبير'},400);const b:any=await req.json();await ensureSchema();if(b.action==='reference'||b.action==='linkReference'){
const linking=b.action==='linkReference';
const before=linking?await db().prepare('SELECT value FROM settings WHERE key=?').bind('reconciliationReference').first():null;
let items=b.items;
if(linking){
 const item=b.item as Item;
 if(!item||item.active!==true)return json({error:'أكمل تعريف الصنف قبل الربط'},400);
 const current=before?JSON.parse(String(before.value)) as Item[]:defaults as Item[];
 const existing=current.find(entry=>entry.code===item.code);
 const occupied=sapReferences(current).find(entry=>entry.sapCode===item.sapCode);
 if(occupied&&(occupied.code!==item.code||occupied.active||existing?.sapCode!==item.sapCode))return json({error:'كود SAP مرتبط مسبقًا. راجع مرجع الأصناف أو حدّث الصفحة.'},409);
 if(existing&&existing.sapCode!==item.sapCode){
  if(!existing.active)return json({error:'فعّل صنف المؤسسة في المرجع قبل إضافة كود SAP آخر.'},409);
  const {sapCode,sapUnit,cartonPieces,kgPerPiece}=item;
  items=current.map(entry=>entry===existing?{...entry,sapAliases:[...(entry.sapAliases||[]),{sapCode,sapUnit,cartonPieces,kgPerPiece}]}:entry);
 }else{
  items=existing?current.map(entry=>entry===existing?{...item,sapAliases:existing.sapAliases}:entry):[...current,item];
 }
}
if(!Array.isArray(items)||items.length<1||items.length>500)return json({error:'قائمة الأصناف غير صالحة'},400);
const codes=new Set<string>(),sap=new Set<string>();
for(const item of items as Item[]){
 if(!item||!/^\d{8}$/.test(item.code)||!item.name?.trim()||item.name.length>350||codes.has(item.code)||typeof item.active!=='boolean'||item.price!==null&&(!Number.isInteger(item.price)||item.price<0||item.price>100000000)||item.sapAliases!==undefined&&(!Array.isArray(item.sapAliases)||item.sapAliases.some(alias=>!alias||typeof alias!=='object')))return json({error:'راجع رقم المؤسسة وتسمية الصنف والسعر.'},400);
 codes.add(item.code);
 for(const entry of [item,...(item.sapAliases||[])]){
  if(!/^[A-Z]{2,6}\d{3,10}$/.test(entry.sapCode)||sap.has(entry.sapCode)||!['Piece','Carton','KG'].includes(entry.sapUnit)||entry.cartonPieces!==null&&(!Number.isInteger(entry.cartonPieces)||entry.cartonPieces<=0||entry.cartonPieces>100000)||entry.kgPerPiece!==null&&(!Number.isFinite(entry.kgPerPiece)||entry.kgPerPiece<=0||entry.kgPerPiece>10000))return json({error:'راجع أكواد SAP والوحدات والشدّات. كل كود SAP يُربط بصنف مؤسسة واحد.'},400);
  sap.add(entry.sapCode);
 }
}
const value=JSON.stringify(items);
if(linking){
 const write=before
  ?db().prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(value,'reconciliationReference',before.value)
  :db().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind('reconciliationReference',value);
 if(!(await write.run()).meta.changes)return json({error:'تغير مرجع الأصناف أثناء الربط. أعد المحاولة.'},409);
 return json({reference:items});
}
await db().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('reconciliationReference',value).run();return json({ok:true})}
if(b.action==='mergeGroups'){
 const {firstId,secondId,firstVersion,secondVersion,reverse,invoiceNumber}=b;
 if(typeof firstId!=='string'||typeof secondId!=='string'||firstId===secondId||!Number.isInteger(firstVersion)||!Number.isInteger(secondVersion)||typeof invoiceNumber!=='string'||(reverse!=null&&(typeof reverse.number!=='string'||typeof reverse.date!=='string'||typeof reverse.paste!=='string'||reverse.paste.length>500000)))return json({error:'بيانات الدمج غير صالحة.'},400);
 const first:any=await db().prepare('SELECT * FROM reconciliations WHERE id=?').bind(firstId).first();
 const second:any=await db().prepare('SELECT * FROM reconciliations WHERE id=?').bind(secondId).first();
 if(!first||!second||first.version!==firstVersion||second.version!==secondVersion)return json({error:'تغير أحد السجلين؛ حدّث الصفحة وأعد المحاولة.'},409);
 let combined:Draft;
 try{combined=prepareGroupMerge({...JSON.parse(first.payload),id:first.id,version:first.version},{...JSON.parse(second.payload),id:second.id,version:second.version},reverse??null,invoiceNumber)}catch(error){return json({error:error instanceof Error?error.message:'تعذّر تجهيز الدمج.'},400)}
 const numbers=combined.transfers.flatMap(t=>transferNumbers(t.number));const invoice=documentNo(invoiceNumber);
 const others:any=await db().prepare("SELECT r.id,json_extract(t.value,'$.number') AS number FROM reconciliations r,json_each(r.payload,'$.transfers') t WHERE r.id<>? AND r.id<>?").bind(firstId,secondId).all();
 const occupied=new Set((others.results||[]).flatMap((row:any)=>transferNumbers(String(row.number||''))));
 if(numbers.some(n=>occupied.has(n)))return json({error:'أحد الترحيلات موجود في مجموعة أخرى.'},409);
 const invoices:any=await db().prepare("SELECT json_extract(i.value,'$.number') AS number FROM reconciliations r,json_each(r.payload,'$.invoices') i WHERE r.id<>? AND r.id<>?").bind(firstId,secondId).all();
 if((invoices.results||[]).some((row:any)=>documentNo(String(row.number||''))===invoice))return json({error:'رقم الفاتورة موجود في مجموعة ثالثة؛ يلزم مراجعتها.'},409);
 const result=reconcile(combined,combined.referenceSnapshot||await refs());const now=new Date().toISOString(),token=crypto.randomUUID(),archiveId=crypto.randomUUID(),version=first.version+1;
 const payload=JSON.stringify({...combined,version,summary:{status:result.status,total:result.total,expected:result.expected,priceDifference:result.priceDifference,differences:result.differences,review:result.review}});
 const guard="EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND revision_token=?)";
 const statements:any[]=[
  db().prepare("INSERT INTO reconciliation_merge_backup(id,created,first_record,second_record) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND version=?)").bind(archiveId,now,JSON.stringify(first),JSON.stringify(second),firstId,firstVersion,secondId,secondVersion),
  db().prepare("UPDATE reconciliations SET transfer_no=?,payload=?,status=?,updated=?,version=?,revision_token=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND version=?)").bind(combined.transfers[0].number,payload,result.status,now,version,token,firstId,firstVersion,secondId,secondVersion),
  db().prepare("DELETE FROM transfer_keys WHERE group_id IN (?,?) AND "+guard).bind(firstId,secondId,firstId,token),
  db().prepare("DELETE FROM invoice_keys WHERE group_id IN (?,?) AND "+guard).bind(firstId,secondId,firstId,token),
  db().prepare("DELETE FROM reconciliations WHERE id=? AND version=? AND "+guard).bind(secondId,secondVersion,firstId,token)
 ];
 for(const n of numbers)statements.push(db().prepare("INSERT INTO transfer_keys(key,group_id) SELECT ?,? WHERE "+guard).bind(n,firstId,firstId,token));
 statements.push(db().prepare("INSERT INTO invoice_keys(key,group_id) SELECT ?,? WHERE "+guard).bind('GLOBAL|'+invoice,firstId,firstId,token));
 try{const outcome=await db().batch(statements);if(!outcome[0].meta.changes||!outcome[1].meta.changes||!outcome[4].meta.changes)return json({error:'تغير السجل أثناء الدمج؛ حدّث الصفحة.'},409)}catch{return json({error:'تعارض أثناء الدمج؛ لم يتم حفظ التعديل.'},409)}
 return json({id:firstId,version,archiveId});
}
if(b.action==='save'){const d=b.draft as Draft;const branchSetting:any=await db().prepare('SELECT value FROM settings WHERE key=?').bind('branches').first();const allowedBranches=branchSetting?JSON.parse(branchSetting.value):branches;if(!d||!Array.isArray(d.transfers)||!d.transfers.length||d.transfers.length>30||!Array.isArray(d.invoices)||d.invoices.length<1||d.invoices.length>30||!allowedBranches.includes(d.branch)||typeof d.driver!=='string'||d.driver.length>120||!dateValue(d.date)||typeof d.notes!=='string'||d.notes.length>5000)return json({error:'أكمل الفرع والتاريخ ومجموعة الترحيلات والفواتير'},400);if(d.mode!==undefined&&d.mode!=='manual'||d.checks!==undefined&&(!d.checks||typeof d.checks!=='object'||Array.isArray(d.checks)||Object.keys(d.checks).length>500||Object.values(d.checks).some(c=>!c||typeof c.signature!=='string'||c.signature.length>200000||!['match','difference'].includes(c.state)||c.note!==undefined&&(typeof c.note!=='string'||c.note.length>1000))))return json({error:'بيانات التشييك غير صالحة'},400);const ts=d.transfers.map(t=>documentNo(String(t.number||'')));const ns=d.invoices.map(i=>documentNo(String(i.number||'')));if(ts.some(n=>!n||n.length>80)||ns.some((n,j)=>n.length>80||!n&&d.invoices[j].complete)||new Set(ts).size!==ts.length||new Set(ns).size!==ns.length||d.transfers.some(t=>!dateValue(t.date)||typeof t.paste!=='string'||t.paste.length>500000)||d.invoices.some(i=>i.title!==undefined&&(typeof i.title!=='string'||i.title.length>80)||typeof i.amount!=='string'||i.amount.length>30||typeof i.complete!=='boolean'||!i.quantities||typeof i.quantities!=='object'||Array.isArray(i.quantities)||Object.keys(i.quantities).length>500||Object.values(i.quantities).some(v=>typeof v!=='string'||v.length>40)||i.date&&!dateValue(i.date)))return json({error:'راجع أرقام المستندات والتواريخ؛ لا تكرر المستند داخل المجموعة'},400);const id=d.id||crypto.randomUUID();const old:any=d.id?await db().prepare('SELECT * FROM reconciliations WHERE id=?').bind(id).first():null;if(d.id&&!old)return json({error:'السجل غير موجود'},404);if(old&&old.version!==d.version)return json({error:'عُدّل السجل من جلسة أخرى؛ افتحه مجددًا قبل الحفظ'},409);if(old){const previous=JSON.parse(String(old.payload)) as Draft;for(const previousInvoice of previous.invoices||[]){if(previousInvoice.manualNumber&&previousInvoice.number){const incoming=d.invoices.find(i=>i.id===previousInvoice.id);if(incoming&&documentNo(incoming.number)!==documentNo(previousInvoice.number)&&!incoming.manualNumber)return json({error:'لا يمكن للاستيراد استبدال رقم الفاتورة الزرقاء الذي صُحّح يدويًا. افتح الفاتورة وعدّل رقمها بنفسك.'},409)}}}
const transferKeys=ts.flatMap(transferNumbers);
if(transferKeys.length!==new Set(transferKeys).size)return json({error:'رقم ترحيل مكرر داخل المجموعة.'},400);
const prior:any=await db().prepare("SELECT r.id,json_extract(t.value,'$.number') AS number FROM reconciliations r, json_each(r.payload,'$.transfers') t WHERE r.id<>?").bind(id).all();
const priorNumbers=new Set((prior.results||[]).flatMap((row:any)=>transferNumbers(String(row.number||''))));
for(const number of transferKeys)if(priorNumbers.has(number))return json({error:'الترحيل '+number+' مسجل في مجموعة أخرى؛ افتحها لإكمال المطابقة.'},409);
const priorInvoices:any=await db().prepare("SELECT r.id,json_extract(i.value,'$.number') AS number FROM reconciliations r, json_each(r.payload,'$.invoices') i WHERE r.id<>?").bind(id).all();
const invoiceOwners=new Set((priorInvoices.results||[]).map((row:any)=>documentNo(String(row.number||''))).filter(Boolean));
for(const number of ns.filter(Boolean))if(invoiceOwners.has(number))return json({error:'رقم الفاتورة الزرقاء '+number+' مسجل في مجموعة أخرى؛ افتح المجموعة الموجودة وأضف الترحيل إليها.'},409);
for(const key of transferKeys){const r:any=await db().prepare('SELECT group_id FROM transfer_keys WHERE key=?').bind(key).first();if(r&&r.group_id!==id)return json({error:'ترحيل مسجل ضمن مجموعة أخرى: '+key},409)}
for(const number of ns.filter(Boolean)){const r:any=await db().prepare("SELECT group_id FROM invoice_keys WHERE substr(key,instr(key,'|')+1)=? AND group_id<>? LIMIT 1").bind(number,id).first();if(r)return json({error:'رقم الفاتورة الزرقاء '+number+' مسجل في مجموعة أخرى؛ افتح المجموعة الموجودة وأضف الترحيل إليها.'},409)}
const {linkedSapCodes,...savedDraft}=d;
if(linkedSapCodes!==undefined&&(!Array.isArray(linkedSapCodes)||linkedSapCodes.length>500||linkedSapCodes.some(code=>typeof code!=='string'||!(/^[A-Z]{2,6}\d{3,10}$/).test(code))))return json({error:'بيانات ربط الأصناف غير صالحة'},400);
const snapshot=old&&!d.useCurrentReference?JSON.parse(old.payload).referenceSnapshot:undefined;
const ref=snapshot&&!linkedSapCodes?.length?snapshot:groupReference(snapshot,await refs(),linkedSapCodes),result=reconcile(d,ref),version=(old?.version||0)+1,nonce=crypto.randomUUID(),now=new Date().toISOString();const acceptedDifference='acceptedDifference' in result&&result.acceptedDifference===true;const clean=withInvoiceDates({...savedDraft,acceptedDifference:acceptedDifference?d.acceptedDifference:undefined,id,version,useCurrentReference:false,transfers:d.transfers.map((t,j)=>({...t,number:ts[j]})),invoices:d.invoices.map((i,j)=>({...i,number:ns[j]}))});const payload=JSON.stringify({...clean,referenceSnapshot:ref,summary:{status:result.status,acceptedDifference,total:result.total,expected:result.expected,priceDifference:result.priceDifference,differences:result.differences,review:result.review}});const queries:any[]=[];
if(old)queries.push(db().prepare('UPDATE reconciliations SET transfer_no=?,branch=?,driver=?,doc_date=?,payload=?,status=?,updated=?,version=?,revision_token=? WHERE id=? AND version=?').bind(ts[0],d.branch,d.driver,d.date,payload,result.status,now,version,nonce,id,old.version));else queries.push(db().prepare('INSERT INTO reconciliations(id,transfer_no,branch,driver,doc_date,payload,status,created,updated,version,revision_token) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,ts[0],d.branch,d.driver,d.date,payload,result.status,now,now,version,nonce));
for(const table of ['transfer_keys','invoice_keys'])queries.push(db().prepare('DELETE FROM '+table+' WHERE group_id=? AND EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND revision_token=?)').bind(id,id,nonce));for(const [table,keys] of [['transfer_keys',transferKeys],['invoice_keys',ns.filter(Boolean).map(n=>'GLOBAL|'+n)]] as const)for(const key of keys)queries.push(db().prepare('INSERT INTO '+table+'(key,group_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND revision_token=?)').bind(key,id,id,nonce));let saved;try{saved=await db().batch(queries)}catch{return json({error:'تعارض في أرقام الفواتير أو الترحيلات؛ حدّث السجل وراجع المستندات'},409)}if(!saved[0].meta.changes)return json({error:'عُدّل السجل في جلسة أخرى؛ افتحه مجددًا'},409);return json({id,version,referenceSnapshot:ref})}
return json({error:'طلب غير معروف'},400)}catch{return json({error:'تعذّر الحفظ. أعد المحاولة.'},500)}}
