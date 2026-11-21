import {readJson} from './bounded-read';
import type {LieutenantTransfer} from './lieutenant';
export type ActiveSnapshot={key:string;documents:number;activeCount:number;created:string;committed:string};
/** Read the exact active D1 snapshot, pinned across every page. No archive or
 * shared upload is silently substituted for an unverified active snapshot. */
export async function readActiveSap(signal:AbortSignal,progress:(page:number)=>void=()=>{}):Promise<{snapshot:ActiveSnapshot;transfers:LieutenantTransfer[]}>{
 let snapshot:ActiveSnapshot|undefined,after='';
 const seen=new Set<string>(),transfers:LieutenantTransfer[]=[];
 for(let page=1;page<=1000;page++){
  signal.throwIfAborted();progress(page);
  const params=new URLSearchParams({rows:'1'});
  if(snapshot){params.set('key',snapshot.key);params.set('after',after)}
  const data=await readJson<{snapshot:ActiveSnapshot|null;rows:{transfer_no:string;payload:string}[];hasMore:boolean;next:string|null}>('/api/sap-snapshot?'+params,signal);
  if(!data.snapshot||!Array.isArray(data.rows))throw Error('لا توجد نسخة SAP معتمدة قابلة للقراءة من D1.');
  const current=data.snapshot;
  if(!Number.isSafeInteger(current.documents)||current.documents<1||current.activeCount!==current.documents||
    snapshot&&(snapshot.key!==current.key||snapshot.committed!==current.committed||snapshot.documents!==current.documents))
   throw Error('نسخة SAP ناقصة أو تغيّرت أثناء الفحص. أعد المحاولة.');
  snapshot=current;
  for(const row of data.rows){
   if(typeof row.transfer_no!=='string'||row.transfer_no<=after||seen.has(row.transfer_no))throw Error('تسلسل ترحيلات D1 غير مكتمل.');
   let item:LieutenantTransfer;
   try{item=JSON.parse(row.payload)}catch{throw Error('بيانات ترحيل D1 غير مقروءة؛ الفحص غير مكتمل.')}
   if(item?.transfer?.number!==row.transfer_no||typeof item.transfer.paste!=='string'||typeof item.transfer.date!=='string'||
     typeof item.remarks!=='string'||typeof item.branch!=='string'||!Array.isArray(item.invoiceNumbers)||!Array.isArray(item.issues))throw Error('بيانات ترحيل D1 غير مكتملة.');
   seen.add(row.transfer_no);transfers.push(item);
  }
  if(data.hasMore===false){
   if(transfers.length!==snapshot.documents)throw Error('لم تُقرأ جميع ترحيلات SAP المعتمدة من D1.');
   return {snapshot,transfers};
  }
  if(data.hasMore!==true||!data.rows.length||data.next!==data.rows.at(-1)?.transfer_no||!data.next||data.next<=after)throw Error('انقطع تسلسل صفحات SAP في D1.');
  after=data.next;
 }
 throw Error('تجاوز SAP حد الصفحات؛ الفحص غير مكتمل.');
}
