import {env} from 'cloudflare:workers';
import {dateValue,invoiceDocumentNo,readReconciliationRecord} from '../../lib/reconcile';
import {invoiceDate} from '../../lib/invoice-collector';
import {readJsonRequest,JsonRequestError} from '../../lib/json-request';

export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const db=()=>{if(!env.DB)throw Error('قاعدة بيانات المؤسسة غير متاحة');return env.DB};
const schema=[
 "CREATE TABLE IF NOT EXISTS colonel_days (day TEXT PRIMARY KEY NOT NULL, invoices_complete INTEGER NOT NULL DEFAULT 0, confirmed_at TEXT NOT NULL, confirmed_by TEXT NOT NULL DEFAULT 'operator')",
 "CREATE TABLE IF NOT EXISTS colonel_transfer_days (transfer_no TEXT PRIMARY KEY NOT NULL, invoice_day TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL)",
 "CREATE TABLE IF NOT EXISTS colonel_events (id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, entity_no TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)"
];
let init:Promise<unknown>|undefined;
const ensure=()=>init??=db().batch(schema.map(s=>db().prepare(s))).catch(error=>{init=undefined;throw error});
const monthValid=(month:string)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(month);
const dayValid=(day:string)=>dateValue(day)===day;
const numberValid=(number:string)=>/^\d{4,20}$/.test(number);
const log=(kind:string,entity:string,note:string,now:string)=>db().prepare(
 'INSERT INTO colonel_events (id,event_type,entity_no,note,created_at) VALUES (?,?,?,?,?)'
).bind(crypto.randomUUID(),kind,entity,note,now);
const issue=(error:unknown)=>error instanceof Error?error.message:'تعذّر تنفيذ الإجراء';
export async function GET(request:Request){
 try{
  await ensure();
  const month=new URL(request.url).searchParams.get('month')||'';
  if(!monthValid(month))return json({error:'اختر شهرًا صالحًا بصيغة YYYY-MM.'},400);
  const [states,assignments,decisions,events,edited]=await Promise.all([
   db().prepare('SELECT day,invoices_complete,confirmed_at,confirmed_by FROM colonel_days WHERE day LIKE ? ORDER BY day')
    .bind(month+'-%').all(),
   db().prepare('SELECT transfer_no,invoice_day,reason,updated_at FROM colonel_transfer_days ORDER BY updated_at DESC').all(),
   db().prepare('SELECT transfer_no,decision,related_type,related_number,note,revision,updated_at FROM lieutenant_cancellation_decisions ORDER BY updated_at DESC').all(),
   db().prepare('SELECT event_type,entity_no,note,created_at FROM colonel_events ORDER BY created_at DESC LIMIT 100').all(),
   db().prepare('SELECT id,branch,updated FROM reconciliations ORDER BY updated DESC LIMIT 100').all(),
  ]);
  return json({days:states.results,assignments:assignments.results,decisions:decisions.results,
   events:events.results,recentProjectEdits:edited.results});
 }catch(error){return json({error:issue(error)},500)}
}
export async function POST(request:Request){
 try{
  await ensure();
  const data=await readJsonRequest(request,16384) as Record<string,unknown>;
  if(!data||typeof data!=='object'||Array.isArray(data))return json({error:'بيانات غير صالحة.'},400);
  const action=data.action;
  const day=typeof data.day==='string'?data.day.trim():'';
  const number=typeof data.transferNo==='string'?data.transferNo.trim():'';
  const reason=typeof data.reason==='string'?data.reason.trim():'';
  const now=new Date().toISOString();
  if(action==='complete-day'||action==='reopen-day'){
   if(!dayValid(day))return json({error:'تاريخ اليوم غير صالح.'},400);
   if(action==='complete-day'){
    // Confirm only that all project invoices currently known for this DAY
    // have a valid number and the operator marked their paper as received.
    // This is NEVER final stock/SAP closure.
    const saved=await db().prepare('SELECT id,payload FROM reconciliations').all<{id:string;payload:string}>();
    let seen=0;
    for(const record of saved.results){
     const draft=readReconciliationRecord(record.payload);
     if(!draft)return json({error:'يوجد سجل مشروع غير مقروء؛ لا يمكن تأكيد اكتمال اليوم.'},409);
     for(const invoice of draft.invoices){
      if(invoiceDate(invoice,draft.transfers).date!==day)continue;
      seen++;
      if(!invoiceDocumentNo(invoice.number)||invoice.complete!==true)
       return json({error:'يوم '+day+' يحتوي فاتورة بلا رقم صحيح أو غير مؤكدة الوصول في المشروع.'},409);
     }
    }
    if(!seen)return json({error:'لا توجد فواتير زرقاء مثبتة بتاريخ '+day+' في سجلات المشروع.'},409);
   }
   await db().batch([
    db().prepare('INSERT INTO colonel_days (day,invoices_complete,confirmed_at,confirmed_by) VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET invoices_complete=excluded.invoices_complete,confirmed_at=excluded.confirmed_at,confirmed_by=excluded.confirmed_by')
     .bind(day,action==='complete-day'?1:0,now,'operator'),
    log(action,day,action==='complete-day'?'أكد المستخدم اكتمال إدخال الفواتير الزرقاء؛ لم يعتمد إغلاق SAP.':'أعاد المستخدم فتح متابعة الفواتير.',now),
   ]);
   return json({ok:true});
  }
  if(action==='assign-transfer'||action==='clear-assignment'){
   if(!numberValid(number))return json({error:'رقم الترحيل غير صالح.'},400);
   if(action==='assign-transfer'){
    if(!dayValid(day))return json({error:'اختر تاريخ الفاتورة الزرقاء الصحيح.'},400);
    if(reason.length<6||reason.length>500||/[\u0000-\u0008\u000e-\u001f\u007f]/.test(reason))
     return json({error:'اكتب سبب الربط وتأكيد مصدر تاريخ الفاتورة (6–500 حرف).'},400);
    await db().batch([
     db().prepare('INSERT INTO colonel_transfer_days (transfer_no,invoice_day,reason,updated_at) VALUES (?,?,?,?) ON CONFLICT(transfer_no) DO UPDATE SET invoice_day=excluded.invoice_day,reason=excluded.reason,updated_at=excluded.updated_at')
      .bind(number,day,reason,now),
     log('assign-transfer',number,'ربط يوم متابعة '+day+'؛ '+reason,now),
    ]);
   }else{
    await db().batch([
     db().prepare('DELETE FROM colonel_transfer_days WHERE transfer_no=?').bind(number),
     log('clear-assignment',number,'إزالة ربط يوم المتابعة اليدوي؛ دون تعديل فاتورة أو SAP.',now),
    ]);
   }
   return json({ok:true});
  }
  return json({error:'إجراء غير معروف.'},400);
 }catch(error){
  if(error instanceof JsonRequestError)return json({error:error.message},error.status);
  return json({error:issue(error)},500);
 }
}
