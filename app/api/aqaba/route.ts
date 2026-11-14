import {env} from 'cloudflare:workers';
import {readJsonRequest,JsonRequestError} from '../../lib/json-request';
import {AQABA_CUSTOMER,AQABA_START,type AqabaLine,type BlueLine} from '../../lib/aqaba';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const db=()=>{if(!env.DB)throw Error('قاعدة البيانات غير متاحة') ;return env.DB};
let ready:Promise<unknown>|undefined;
function schema(){return ready??=db().batch([
 db().prepare("CREATE TABLE IF NOT EXISTS aqaba_official (id TEXT PRIMARY KEY NOT NULL, doc_no TEXT NOT NULL, doc_date TEXT NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL)"),
 db().prepare("CREATE INDEX IF NOT EXISTS aqaba_official_doc ON aqaba_official (doc_no,doc_date)"),
 db().prepare("CREATE TABLE IF NOT EXISTS aqaba_blue (id TEXT PRIMARY KEY NOT NULL, doc_no TEXT NOT NULL, doc_date TEXT NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL)"),
 db().prepare("CREATE INDEX IF NOT EXISTS aqaba_blue_doc ON aqaba_blue (doc_no,doc_date)"),
 db().prepare("CREATE TABLE IF NOT EXISTS aqaba_audit (id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL, item_id TEXT NOT NULL, previous TEXT NOT NULL, updated TEXT NOT NULL)")
 ]).catch(error=>{ready=undefined;throw error})}
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>=AQABA_START;
const code=(v:unknown)=>typeof v==='string'&&/^[A-Z]{2,6}\d{3,10}$/.test(v);
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9;
const text=(v:unknown,max=150)=>typeof v==='string'&&v.length<=max;
function validOfficial(x:unknown):x is AqabaLine{
 if(!x||typeof x!=='object')return false;
 const v=x as Record<string,unknown>;
 return text(v.key,120)&&text(v.document,30)&&/^\d{4,20}$/.test(v.document as string)&&
  text(v.docEntry,30)&&date(v.date)&&v.customer===AQABA_CUSTOMER&&v.warehouse==='011'&&
  ['IN','CN','DN','RE'].includes(String(v.kind))&&
  Number.isInteger(v.row)&&Number(v.row)>=1&&Number(v.row)<10000&&
  code(v.item)&&number(v.quantity)&&number(v.unitPrice)&&
  typeof v.lineTotal==='number'&&Number.isFinite(v.lineTotal)&&
  typeof v.tax==='number'&&Number.isFinite(v.tax)&&
  text(v.description,500)&&text(v.unit,80)&&text(v.canceled,30)&&
  ['N','Y','C','غير موضح'].includes(String(v.canceled))&&
  text(v.baseType,60)&&text(v.baseEntry,60)&&text(v.baseLine,60)&&text(v.baseRef,150)&&
  v.inventoryEffect==='unverified' &&
  v.key===[v.kind,v.docEntry||v.document,v.date,v.row].join('|');
}
function validBlue(x:unknown):x is BlueLine{
 if(!x||typeof x!=='object')return false;
 const v=x as Record<string,unknown>;
 return text(v.key,120)&&text(v.invoice,30)&&/^\d{7,20}$/.test(v.invoice as string)&&
  date(v.date)&&code(v.item)&&text(v.description,500)&&number(v.quantity)&&
  number(v.price)&&text(v.unit,80)&&Array.isArray(v.officialNumbers)&&Array.isArray(v.transferNumbers)&&
  v.officialNumbers.length<=40&&v.transferNumbers.length<=40&&
  [...v.officialNumbers,...v.transferNumbers].every(n=>typeof n==='string'&&/^\d{4,20}$/.test(n));
}
export async function GET(req:Request){
 try{
  await schema();
  const u=new URL(req.url),summary=u.searchParams.has('summary');
  const [official,blue]=await Promise.all([
   db().prepare('SELECT payload FROM aqaba_official ORDER BY doc_date DESC,doc_no LIMIT 3000').all<{payload:string}>(),
   db().prepare('SELECT payload FROM aqaba_blue ORDER BY doc_date DESC,doc_no LIMIT 3000').all<{payload:string}>(),
  ]);
  const officialLines=official.results.map(x=>JSON.parse(x.payload) as AqabaLine);
  const blueLines=blue.results.map(x=>JSON.parse(x.payload) as BlueLine);
  if(summary){
   const officialNos=new Set(officialLines.filter(x=>x.kind==='IN').map(x=>x.document));
   const blueNos=new Set(blueLines.map(x=>x.invoice));
   const linked=new Set(blueLines.flatMap(x=>x.officialNumbers));
   return json({officialInvoices:officialNos.size,blueInvoices:blueNos.size,
     unlinkedOfficial:[...officialNos].filter(x=>!linked.has(x)).length,
     unlinkedBlue:[...blueNos].filter(n=>!blueLines.some(x=>x.invoice===n&&x.officialNumbers.length)).length,
     cancellationRows:officialLines.filter(x=>x.canceled==='Y'||x.canceled==='C').length});
  }
  return json({official:officialLines,blue:blueLines});
 }catch{return json({error:'تعذّر قراءة سجل العقبة.'},500)}
}
export async function POST(req:Request){
 try{
  if(req.headers.get('origin')!==new URL(req.url).origin)return json({error:'طلب غير مسموح'},403);
  const body=await readJsonRequest(req);await schema();
  const official=body.action==='aqabaOfficial',blue=body.action==='aqabaBlue';
  if(!official&&!blue)return json({error:'عملية غير معروفة'},400);
  const incoming=body.items;
  if(!Array.isArray(incoming)||incoming.length<1||incoming.length>50||
     !incoming.every(official?validOfficial:validBlue))
    return json({error:'أكواد أو حقول غير صالحة. أرسل من 1 إلى 50 بندًا في كل دفعة.'},400);
  const seen=new Set<string>();
  for(const item of incoming)if(seen.has(item.key))return json({error:'يوجد سطر مكرر بنفس المعرف.'},400);else seen.add(item.key);
  const table=official?'aqaba_official':'aqaba_blue',source=official?'official':'blue';
  const now=new Date().toISOString();
  const statements:ReturnType<ReturnType<typeof db>['prepare']>[]=[];
  let unchanged=0,updated=0,added=0;
  // Keep a complete before-image in append-only audit when SAP changes a document.
  // Never delete a canceled/returned document or mutate Amman reconciliations.
  for(const item of incoming){
   const old=await db().prepare('SELECT payload FROM '+table+' WHERE id=?').bind(item.key).first<{payload:string}>();
   const payload=JSON.stringify(item);
   if(old?.payload===payload){unchanged++;continue}
   if(old){
    statements.push(db().prepare('INSERT INTO aqaba_audit (id,source,item_id,previous,updated) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(),source,item.key,old.payload,now));
    updated++;
   }else added++;
   statements.push(db().prepare('INSERT INTO '+table+' (id,doc_no,doc_date,payload,updated) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated')
    .bind(item.key,official?item.document:item.invoice,item.date,payload,now));
  }
  // A D1 batch is atomic. On a conflict a subsequent import is idempotent.
  if(statements.length)await db().batch(statements);
  return json({ok:true,added,updated,unchanged});
 }catch(e){
  if(e instanceof JsonRequestError)return json({error:e.message},e.status);
  return json({error:'تعذّر حفظ دفعة العقبة. لم يُحذف أي مستند محفوظ.'},500);
 }
}
