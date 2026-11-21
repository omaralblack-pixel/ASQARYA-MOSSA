import {readAllRecords,readJson} from './bounded-read';
import {collectInvoicesByDate} from './invoice-collector';
import type {ReassuranceData,ReassuranceRecord} from './reassurance';

/** Full frozen records, exact D1 count and one stable shared revision. */
export async function readInvoiceLedger(from:string,to:string,signal:AbortSignal,
 progress:(page:number)=>void=()=>{}):Promise<ReassuranceData>{
 const revision=await readJson<{revision:number}>('/api/project-sync?limit=1',signal);
 if(!Number.isSafeInteger(revision.revision))throw Error('تعذّر التحقق من نسخة سجل الفواتير.');
 const [meta,records]=await Promise.all([
  readJson<Pick<ReassuranceData,'reference'|'openingStock'>&{recordCount:number}>(
   '/api/reconcile?reassuranceMeta=1&from='+encodeURIComponent(from),signal),
  readAllRecords<ReassuranceRecord>(cursor=>{
   const params=new URLSearchParams({reassuranceRecords:'1'});
   if(cursor){params.set('afterUpdated',cursor.updated);params.set('afterId',cursor.id)}
   return readJson('/api/reconcile?'+params,signal);
  },progress),
 ]);
 if(!Array.isArray(meta.reference)||!Array.isArray(meta.openingStock)||
   !Number.isSafeInteger(meta.recordCount)||records.length!==meta.recordCount)
  throw Error('عدد سجلات الفواتير أو بياناتها لا يطابق D1؛ الفحص غير مكتمل.');
 const latest=await readJson<{revision:number}>('/api/project-sync?limit=1',signal);
 if(latest.revision!==revision.revision)throw Error('تغيّرت البيانات أثناء قراءة الفواتير. أعد الفحص.');
 return {...collectInvoicesByDate(records,from,to),...meta,records};
}
