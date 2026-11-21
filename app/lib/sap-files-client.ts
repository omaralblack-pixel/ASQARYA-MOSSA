import {boundedFetch,boundedRead,readJson} from './bounded-read';
import {decodeLieutenantFile} from './lieutenant-file';
import type {SapJob} from './sap-processing';
export type SapArchiveFile={key:string;name:string;kind:string;created:string;snapshotDate?:string;size?:number};
/**
 * The Cloudflare edge may return an HTML error page (often HTTP 503) instead of
 * a JSON API response. Parse the body once and report the operation and HTTP
 * status; never leak HTML into JSON.parse or mistake an edge failure for loss of
 * previously completed SAP batches.
 */
export async function readSapJson<T>(res:Response,operation:string):Promise<T>{
 if(res.status===401){
  if(typeof window!=='undefined')window.location.assign('/login');
  throw Error('انتهت جلسة الدخول. سجّل الدخول مرة أخرى ثم افتح الملف من الأرشيف؛ الدفعات المكتملة محفوظة.');
 }
 const body=await res.text().catch(()=> '');
 const type=(res.headers.get('content-type')||'').toLowerCase();
 let data:unknown;
 const preview=body.trimStart();
 if(!type.includes('json')&&!preview.startsWith('{')&&!preview.startsWith('[')){
  const kind=preview.startsWith('<')?'صفحة HTML':'نصًا غير متوقع';
  throw Error('تعذّر '+operation+': HTTP '+res.status+'؛ الخادم أعاد '+kind+' بدل JSON. '+(res.status===503?'تحقّق من خدمة Cloudflare Worker وربط D1/Supabase. ':'')+'الدفعات المكتملة لا تحتاج إعادة رفع.');
 }
 try{data=JSON.parse(body)}
 catch{throw Error('تعذّر '+operation+': HTTP '+res.status+'؛ رد الخادم ليس JSON صالحًا. لا تعِد رفع الملف؛ استكمل من الأرشيف بعد معالجة عطل الخادم.')}
 if(!data||typeof data!=='object'){
  throw Error('تعذّر '+operation+': HTTP '+res.status+'؛ بنية استجابة الخادم غير صالحة.');
 }
 const apiError=(data as {error?:unknown}).error;
 if(!res.ok)throw Error('تعذّر '+operation+': HTTP '+res.status+'؛ '+(typeof apiError==='string'&&apiError?apiError:'الخدمة غير متاحة حاليًا. الدفعات المكتملة محفوظة.'));
 return data as T;
}
class SapRequestFailure extends Error{
 constructor(message:string,readonly status:number|null,readonly retryable:boolean){super(message);}
}
const temporaryStatuses=new Set([408,429,500,502,503,504,520,521,522,523,524]);
const retryDelay=(attempt:number)=>new Promise<void>(resolve=>setTimeout(resolve,1000*2**attempt));
async function sapRequestOnce<T>(url:string,body?:unknown):Promise<T>{
 const task=url.startsWith('/api/sap-processing')?
  (body&&typeof body==='object'&&'action' in body?
    (String((body as {action:unknown}).action)==='batch'?'استكمال دفعة SAP رقم '+(Number((body as {index?:number}).index)+1):'بدء أو إعادة فحص معالجة SAP'):'قراءة حالة معالجة SAP') :
  'قراءة أرشيف SAP';
 try{return await boundedRead(url,async response=>{
  try{return await readSapJson<T>(response,task)}
  catch(error){throw new SapRequestFailure(error instanceof Error?error.message:'تعذّر '+task,response.status,temporaryStatuses.has(response.status))}
 },{timeoutMs:60_000,init:body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}})}
 catch(error){if(error instanceof SapRequestFailure)throw error;throw new SapRequestFailure('انتهت مهلة الاتصال أو تعذّر الاتصال أثناء '+task+'؛ الدفعات المكتملة محفوظة.',null,true)}
}
export async function sapRequest<T>(url:string,body?:unknown):Promise<T>{
 const batch=body&&typeof body==='object'?body as {action?:unknown;key?:unknown;index?:unknown}:null;
 if(url!=='/api/sap-processing'||batch?.action!=='batch'||typeof batch.key!=='string'||!Number.isSafeInteger(batch.index))
  return sapRequestOnce<T>(url,body);
 for(let attempt=0;;attempt++){
  try{return await sapRequestOnce<T>(url,body);}
  catch(error){
   if(!(error instanceof SapRequestFailure)||!error.retryable)throw error;
   // A gateway error may arrive after D1 committed the batch. Read its exact
   // durable state before retrying; never reset a plan or bypass its lease.
   let state:SapJob|null=null;
   for(let probe=0;probe<3;probe++){
    try{
     state=(await sapRequestOnce<{job:SapJob|null}>(url+'?key='+encodeURIComponent(batch.key))).job;
     break;
    }catch(readError){
     if(!(readError instanceof SapRequestFailure)||!readError.retryable)throw readError;
     if(probe<2)await retryDelay(probe);
    }
   }
   const saved=state?.key===batch.key?state.batches.find(item=>item.idx===batch.index):undefined;
   if(!state||!saved)throw error;
   if(saved.state==='complete'||saved.state==='failed')return {job:state} as T;
   if(saved.state==='running')return {job:state,busy:true} as T;
   if(attempt>=2)throw error;
   await retryDelay(attempt);
  }
 }
}
/** Bound upload/download response bodies too, before handing them to parsers. */
export function sapFetch(url:string,init:RequestInit={}):Promise<Response>{return boundedFetch(url,init,60_000)}
export async function listSapFiles(options:{signal?:AbortSignal}={}):Promise<SapArchiveFile[]>{
 const files:SapArchiveFile[]=[];let page:number|null=0;
 const pages=new Set<number>(),keys=new Set<string>();
 do{
  if(!Number.isSafeInteger(page)||page<0||pages.has(page)||pages.size>=1000)throw Error('تسلسل صفحات أرشيف SAP غير مكتمل. أعد المحاولة.');
  pages.add(page);
  options.signal?.throwIfAborted();
  const next:{files:SapArchiveFile[];nextPage:number|null}=await (options.signal?readJson('/api/lieutenant-files?page='+page,options.signal):sapRequest('/api/lieutenant-files?page='+page));
  if(!Array.isArray(next.files)||!(next.nextPage===null||Number.isSafeInteger(next.nextPage)))throw Error('استجابة أرشيف SAP غير مكتملة.');
  for(const file of next.files){
   if(!file||typeof file.key!=='string'||keys.has(file.key))throw Error('تغيّرت قائمة أرشيف SAP أثناء القراءة. أعد المحاولة.');
   keys.add(file.key);files.push(file);
  }
  page=next.nextPage;
 }while(page!==null);
 return files;
}
// Immutable keys make this cache safe across screen navigation. Errors are
// evicted; mutable archive lists and job states are always read from the server.
const texts=new Map<string,string>();
const reads=new Map<string,Promise<string>>();
export function readSapArchive(file:{key:string;name:string},options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<string>{
 options.signal?.throwIfAborted();
 const cached=texts.get(file.key);if(cached!==undefined)return Promise.resolve(cached);
 // A caller's cancellation must not cancel another screen's read or poison its cache.
 if(!options.signal&&reads.has(file.key))return reads.get(file.key)!;
 const result=boundedRead('/api/lieutenant-files?key='+encodeURIComponent(file.key),async res=>{
  if(!res.ok)throw Error('تعذّر قراءة الملف المحفوظ: HTTP '+res.status);
  const text=decodeLieutenantFile(await res.arrayBuffer(),file.name);
  options.signal?.throwIfAborted();
  texts.set(file.key,text);if(texts.size>8)texts.delete(texts.keys().next().value!);
  return text;
 },{signal:options.signal,timeoutMs:options.timeoutMs??45_000});
 if(!options.signal){reads.set(file.key,result);void result.finally(()=>{if(reads.get(file.key)===result)reads.delete(file.key)}).catch(()=>{})}
 return result;
}
