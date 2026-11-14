export class JsonRequestError extends Error{
 constructor(message:string,public status:number){super(message)}
}

/** Enforce the real body size, including requests without Content-Length. */
export async function readJsonRequest(request:Request,maxBytes=3_000_000):Promise<Record<string,any>>{
 if(Number(request.headers.get('content-length')||0)>maxBytes)
  throw new JsonRequestError('حجم البيانات كبير. قسّم الطلب إلى دفعات أصغر.',413);
 const reader=request.body?.getReader();
 if(!reader)throw new JsonRequestError('طلب الحفظ فارغ.',400);
 const decoder=new TextDecoder('utf-8',{fatal:true});
 let size=0,text='';
 try{
  while(true){
   const {value,done}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>maxBytes)throw new JsonRequestError('حجم البيانات كبير. قسّم الطلب إلى دفعات أصغر.',413);
   text+=decoder.decode(value,{stream:true});
  }
  text+=decoder.decode();
 }catch(error){
  await reader.cancel().catch(()=>{});
  if(error instanceof JsonRequestError)throw error;
  throw new JsonRequestError('تعذّر قراءة بيانات الطلب. أعد المحاولة.',400);
 }finally{reader.releaseLock()}
 let data:unknown;
 try{data=JSON.parse(text)}catch{throw new JsonRequestError('بيانات الطلب ليست JSON صالحًا.',400)}
 if(!data||typeof data!=='object'||Array.isArray(data))
  throw new JsonRequestError('بيانات الطلب غير صالحة.',400);
 return data as Record<string,any>;
}
