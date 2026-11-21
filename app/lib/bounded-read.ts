/** Read-only requests: bound both headers and body, and release listeners even
 * when a transport ignores AbortSignal. No automatic retry of business writes. */
export async function boundedRead<T>(url:string,read:(response:Response)=>Promise<T>,
  options:{signal?:AbortSignal;timeoutMs?:number;init?:RequestInit}={}):Promise<T>{
  options.signal?.throwIfAborted();
  const controller=new AbortController();
  const parent=options.signal;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let onAbort:()=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{
    onAbort=()=>{const reason=parent?.reason||new Error('أُلغي الطلب السابق.');controller.abort(reason);reject(reason)};
    if(parent?.aborted){onAbort();return}
    parent?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>{
      const error=new Error('انتهت مهلة قراءة البيانات. أعد المحاولة؛ الفحص غير مكتمل.');
      controller.abort(error);reject(error);
    },options.timeoutMs??30_000);
  });
  try{
    if(controller.signal.aborted)throw controller.signal.reason;
    return await Promise.race([stopped,(async()=>{
      const response=await fetch(url,{cache:'no-store',redirect:'manual',...options.init,signal:controller.signal});
      return read(response);
    })()]);
  }finally{clearTimeout(timer);parent?.removeEventListener('abort',onAbort)}
}

export function readJson<T>(url:string,signal?:AbortSignal):Promise<T>{
  return boundedRead(url,async response=>{
    if(response.status===401||response.type==='opaqueredirect')throw Error('انتهت جلسة الدخول. سجّل دخولك وأعد الفحص.');
    if(!(response.headers.get('content-type')||'').includes('json'))
      throw Error('تعذّر قراءة البيانات: HTTP '+response.status+'؛ استجابة الخدمة ليست JSON. أعد المحاولة.');
    let data:T&{error?:string};
    try{data=await response.json()}
    catch{throw Error('استجابة البيانات غير مكتملة أو ليست JSON صالحًا (HTTP '+response.status+'). أعد المحاولة.')}
    if(!response.ok)throw Error(data?.error||'تعذّر تحميل البيانات (HTTP '+response.status+').');
    return data;
  },{signal});
}

/** Preserve input order and every failure; never drop failed tasks. */
export async function mapBounded<T,R>(items:T[],limit:number,read:(item:T,index:number)=>Promise<R>):Promise<R[]>{
  if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid concurrency');
  const result:R[]=new Array(items.length);let next=0,failed=false;let failure:unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length&&!failed){
      const index=next++;
      try{result[index]=await read(items[index],index)}catch(error){failed=true;failure=error}
    }
  }));
  if(failed)throw failure;
  return result;
}

export async function readAllRecords<T extends {id:string;payload:string}>(
  read:(cursor:{updated:string;id:string}|null)=>Promise<{records:T[];hasMore:boolean;nextCursor:{updated:string;id:string}|null}>,
  progress:(page:number)=>void=()=>{},
):Promise<T[]>{
  const records:T[]=[],seen=new Set<string>(),cursors=new Set<string>();
  let cursor:{updated:string;id:string}|null=null;
  for(let page=1;page<=1000;page++){
    progress(page);const result=await read(cursor);
    if(!Array.isArray(result.records))throw Error('سجل الفواتير غير مكتمل.');
    for(const record of result.records){
      if(!record||typeof record.id!=='string'||typeof record.payload!=='string'||seen.has(record.id))
        throw Error('سجل الفواتير يحتوي تكرارًا أو ملفًا غير مقروء؛ الفحص غير مكتمل.');
      seen.add(record.id);records.push(record);
    }
    if(result.hasMore===false)return records;
    const next=result.nextCursor;
    if(result.hasMore!==true||!result.records.length||!next||typeof next.updated!=='string'||!next.updated||typeof next.id!=='string'||!next.id)
      throw Error('انقطع تسلسل صفحات الفواتير؛ الفحص غير مكتمل.');
    const key=JSON.stringify(next);
    if(cursors.has(key))throw Error('تكرر مؤشر صفحات الفواتير؛ الفحص غير مكتمل.');
    cursors.add(key);cursor=next;
  }
  throw Error('تجاوز السجل حد صفحات الفحص؛ لا يمكن تأكيد اكتماله.');
}
