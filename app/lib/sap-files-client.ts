import {decodeLieutenantFile} from './lieutenant-file';
export type SapArchiveFile={key:string;name:string;kind:string;created:string;snapshotDate?:string;size?:number};
export async function sapRequest<T>(url:string,body?:unknown):Promise<T>{
 const res=await fetch(url,{cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 if(res.status===401){window.location.assign('/login');throw Error('انتهت جلسة الدخول.');}
 if(!(res.headers.get('content-type')||'').includes('json'))throw Error('الخادم أعاد استجابة غير صالحة: HTTP '+res.status);
 const data=await res.json() as T&{error?:string};if(!res.ok)throw Error(data.error||'تعذّر الاتصال: HTTP '+res.status);return data;
}
export async function listSapFiles():Promise<SapArchiveFile[]>{
 const files:SapArchiveFile[]=[];let page:number|null=0;
 do{const next:{files:SapArchiveFile[];nextPage:number|null}=await sapRequest('/api/lieutenant-files?page='+page);files.push(...next.files);page=next.nextPage;}while(page!==null);
 return files;
}
// Immutable keys make this cache safe across screen navigation. Errors are
// evicted; mutable archive lists and job states are always read from the server.
const texts=new Map<string,Promise<string>>();
export function readSapArchive(file:{key:string;name:string}):Promise<string>{
 const cached=texts.get(file.key);if(cached)return cached;
 const result=fetch('/api/lieutenant-files?key='+encodeURIComponent(file.key),{cache:'no-store'}).then(async res=>{
  if(!res.ok)throw Error('تعذّر قراءة الملف المحفوظ: HTTP '+res.status);
  return decodeLieutenantFile(await res.arrayBuffer(),file.name);
 }).catch(e=>{texts.delete(file.key);throw e;});
 texts.set(file.key,result);if(texts.size>8)texts.delete(texts.keys().next().value!);return result;
}
