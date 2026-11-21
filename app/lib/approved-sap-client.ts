import {boundedRead,readJson} from './bounded-read';
import {decodeLieutenantFile} from './lieutenant-file';
import {parseLieutenantTransfers} from './lieutenant';
import {fromSapStorageFilename} from './sap-archive-filename';
import {isUnifiedSapSource,splitUnifiedSapSource} from './unified-sap-query';
import type {ActiveSnapshot} from './active-sap';

export type ApprovedSapImport={name:string;text:string;key:string;documents:number};
const verified=new Map<string,ApprovedSapImport>();

/** All automatic SAP readers use the original named by D1's active pointer.
 * A stale legacy current.json or a newer unapproved archive is not a fallback. */
export async function readCurrentSapImport(options:{signal?:AbortSignal}={}):Promise<ApprovedSapImport>{
 const controller=new AbortController();
 const cancel=()=>controller.abort(options.signal?.reason);
 options.signal?.throwIfAborted();
 options.signal?.addEventListener('abort',cancel,{once:true});
 const deadline=setTimeout(()=>controller.abort(Error('انتهت مهلة قراءة أصل SAP المعتمد؛ أعد المحاولة.')),90_000);
 const signal=controller.signal;
 const metadata=async()=>{
  const {snapshot}=await readJson<{snapshot:ActiveSnapshot|null}>('/api/sap-snapshot',signal);
  if(!snapshot||!/^lieutenant\/(?:unified|transfers)__[a-f0-9]{32}__[^/\\]+$/.test(snapshot.key)||
    !Number.isSafeInteger(snapshot.documents)||snapshot.documents<1||snapshot.documents!==snapshot.activeCount||
    typeof snapshot.committed!=='string'||!snapshot.committed)
   throw Error('لم يثبت اكتمال نسخة SAP المعتمدة في D1. افتح ملفات SAP للتحقق؛ لم يُستخدم كشف قديم بدلًا منها.');
  return snapshot;
 };
 try{
  const snapshot=await metadata();
  signal.throwIfAborted();
  const cached=verified.get(snapshot.key);
  if(cached&&cached.documents===snapshot.documents)return cached;
  const name=fromSapStorageFilename(snapshot.key.split('__').at(-1)||'SAP.txt');
  const bytes=await boundedRead('/api/lieutenant-files?key='+encodeURIComponent(snapshot.key),async response=>{
   if(!response.ok)throw Error('تعذّر قراءة أصل SAP المعتمد (HTTP '+response.status+'). لم يُستبدل بكشف قديم.');
   const buffer=await response.arrayBuffer();
   if(!buffer.byteLength||buffer.byteLength>16*1024*1024)throw Error('حجم أصل SAP المعتمد غير صالح.');
   return buffer;
  },{signal,timeoutMs:60_000});
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  signal.throwIfAborted();
  if(hash.slice(0,32)!==snapshot.key.split('__')[1])throw Error('بصمة أصل SAP لا تطابق النسخة المعتمدة في D1؛ أُوقف الفحص.');
  const original=decodeLieutenantFile(bytes,name);
  const text=isUnifiedSapSource(original)?splitUnifiedSapSource(original).transfers:original;
  const scan=parseLieutenantTransfers(text,[]);
  if(scan.issues.length||scan.transfers.length!==snapshot.documents)
   throw Error('أصل SAP المقروء لا يحتوي جميع ترحيلات النسخة المعتمدة؛ الفحص غير مكتمل.');
  const latest=await metadata();
  if(latest.key!==snapshot.key||latest.committed!==snapshot.committed||latest.documents!==snapshot.documents)
   throw Error('تغيّرت نسخة SAP أثناء القراءة؛ أعد الفحص.');
  const value={name,text,key:snapshot.key,documents:snapshot.documents};
  verified.set(snapshot.key,value);
  if(verified.size>2)verified.delete(verified.keys().next().value!);
  return value;
 }finally{clearTimeout(deadline);options.signal?.removeEventListener('abort',cancel);controller.abort()}
}
