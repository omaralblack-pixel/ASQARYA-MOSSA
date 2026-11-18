import {createHash,createHmac} from 'node:crypto';
import {env} from 'cloudflare:workers';
import branches from '../../branches.json';
import {lieutenantFiles} from '../../../worker/institution';
import {readJsonRequest,JsonRequestError} from '../../lib/json-request';
import {decodeArchivedSapSource} from '../../lib/sap-source-integrity';
import {buildSapPlan,buildSapBatches,sapProcessorVersion,type SapJob,type SapPlan,type SapBatch} from '../../lib/sap-processing';
import {POST as importTransfers} from '../reconcile/route';
import {POST as importAqaba} from '../aqaba/route';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const db=()=>{if(!env.DB)throw Error('قاعدة معالجة ملفات SAP غير متاحة.');return env.DB;};
let ready:Promise<unknown>|undefined;
export function ensureSapProcessing(){return ready??=db().batch([
 db().prepare('CREATE TABLE IF NOT EXISTS sap_file_jobs (key TEXT PRIMARY KEY, version INTEGER NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL, plan TEXT NOT NULL, total INTEGER NOT NULL, updated TEXT NOT NULL)'),
 db().prepare('CREATE TABLE IF NOT EXISTS sap_job_history (key TEXT NOT NULL,generation TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL,plan TEXT NOT NULL,total INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(key,generation))'),
 db().prepare("CREATE TABLE IF NOT EXISTS sap_batch_history (file_key TEXT NOT NULL,generation TEXT NOT NULL,idx INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL,error TEXT NOT NULL,duration INTEGER NOT NULL,PRIMARY KEY(file_key,generation,idx))"),
 db().prepare('CREATE TABLE IF NOT EXISTS sap_document_receipts (number TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)'),
 db().prepare("CREATE TABLE IF NOT EXISTS sap_file_batches (file_key TEXT NOT NULL, idx INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', token TEXT NOT NULL DEFAULT '', lease INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(file_key,idx))"),
]).catch(e=>{ready=undefined;throw e;});}
const fingerprint=(item:unknown)=>createHash('sha256').update(JSON.stringify(item)).digest('hex');
const validKey=(key:unknown):key is string=>typeof key==='string'&&/^lieutenant\/(?:transfers|opening|balance|unified|other)__[a-f0-9]{32}__(?:\d{4}-\d{2}-\d{2}__)?[^/\\]{1,120}$/.test(key);
async function readJob(key:string,details=true):Promise<SapJob|null>{
 const job=await db().prepare('SELECT * FROM sap_file_jobs WHERE key=?').bind(key).first<{key:string;kind:SapJob['kind'];plan:string;total:number;updated:string}>();
 if(!job)return null;
 const rows=await db().prepare('SELECT idx,state,error,duration'+(details?',result':'')+' FROM sap_file_batches WHERE file_key=? ORDER BY idx').bind(key).all<{idx:number;state:string;error:string;duration:number;result?:string}>();
 const plan=JSON.parse(job.plan) as Omit<SapPlan,'batches'>;
 const done=rows.results.filter(x=>x.state==='complete').length,failed=rows.results.filter(x=>x.state==='failed').length,running=rows.results.filter(x=>x.state==='running').length;
 const documents=details?plan.documents.map(x=>({...x})):[];
 if(details){
  const byNumber=new Map(documents.map(x=>[x.number,x]));
  for(const row of rows.results)if(row.state==='complete'&&row.result){
   const result=JSON.parse(row.result) as {documents?:{number:string;state:string}[]};
   for(const doc of result.documents||[]){const target=byNumber.get(doc.number);if(target){target.state=doc.state;target.reason=doc.state==='added'?'أكد الخادم حفظه':'موجود مسبقًا؛ لم يُكرر';}}
  }
 }
 const status=failed?'failed':done===job.total&&rows.results.length===job.total?
  job.kind==='other'?'archived':plan.issues.length||!plan.count?'review':'complete':running?'running':'pending';
 return {key,kind:job.kind,count:plan.count,total:job.total,done,failed,running,status,issues:details?plan.issues:[],documents,batches:rows.results.map(({idx,state,error,duration})=>({idx,state,error,duration})),updated:job.updated,duration:rows.results.reduce((n,x)=>n+x.duration,0)};
}
export async function GET(req:Request){try{
 await ensureSapProcessing();const key=new URL(req.url).searchParams.get('key');
 if(key){if(!validKey(key))return json({error:'ملف غير صالح.'},400);return json({job:await readJob(key)});}
 const rows=await db().prepare(`SELECT j.key,j.kind,json_remove(j.plan,'$.documents') AS plan,j.total,j.updated,
  COUNT(b.idx) AS actual,SUM(CASE WHEN b.state='complete' THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN b.state='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN b.state='running' THEN 1 ELSE 0 END) AS running,
  COALESCE(SUM(b.duration),0) AS duration FROM sap_file_jobs j LEFT JOIN sap_file_batches b ON b.file_key=j.key GROUP BY j.key ORDER BY j.updated DESC`).all<{key:string;kind:SapJob['kind'];plan:string;total:number;actual:number;updated:string;done:number;failed:number;running:number;duration:number}>();
 const jobs=rows.results.map(row=>{const plan=JSON.parse(row.plan) as SapPlan;
  const status=row.failed?'failed':row.done===row.total&&row.actual===row.total?row.kind==='other'?'archived':plan.issues.length||!plan.count?'review':'complete':row.running?'running':'pending';
  return {...row,plan:undefined,count:plan.count,status,issues:[],documents:[],batches:[]};
 });
 return json({jobs});
}catch{return json({error:'تعذّر قراءة حالة المعالجة المحفوظة.'},500);}}
export async function POST(req:Request){try{
 await ensureSapProcessing();const body=await readJsonRequest(req,32*1024*1024);const key=body.key;
 if(!validKey(key))return json({error:'معرّف ملف غير صالح.'},400);
 if(body.action==='start'){
  const existing=await readJob(key);
  // CPU protection: a Free-tier Worker must not recompute a large source plan
  // while a durable partial import already exists. A requested "recheck"
  // on 1/3 complete is a RESUME, not a plan reset.
  if(existing&&body.recheck===true&&existing.running>0)
   return json({error:'هناك دفعة قيد التنفيذ. حدّث الحالة واستكمل بعد اكتمالها دون إعادة الفحص.'},409);
  if(existing&&(body.recheck!==true||existing.done<existing.total))
   return json({job:existing,reused:true,resumeOnly:existing.done<existing.total});
  if(typeof body.text!=='string'||!body.text.trim()||new TextEncoder().encode(body.text).length>25*1024*1024)return json({error:'نص الملف غير صالح.'},400);
  let plan:SapPlan;
  if(env.SUPABASE_URL&&env.SUPABASE_STORAGE_SECRET){
   // Parse beside Storage, outside the Cloudflare Free 10ms CPU budget.
   // The service independently verifies the immutable original and text hash.
   const payload=JSON.stringify({key,textHash:createHash('sha256').update(body.text).digest('hex')});
   const timestamp=String(Date.now());
   const signature=createHmac('sha256',env.SUPABASE_STORAGE_SECRET).update(timestamp+'\n'+payload).digest('hex');
   const response=await fetch(new URL('/functions/v1/sap-plan',env.SUPABASE_URL),{
    method:'POST',headers:{'Content-Type':'application/json','x-sap-time':timestamp,'x-sap-signature':signature},body:payload,signal:AbortSignal.timeout(60000),
   });
   const result=await response.json().catch(()=>null) as {plan?:SapPlan;error?:string}|null;
   if(!response.ok||!result?.plan)return json({error:'خدمة تحليل SAP: HTTP '+response.status+'؛ '+(result?.error||'رد غير صالح أو تجاوز موارد الخدمة. الأصل والدفعات السابقة محفوظة؛ أعد المحاولة بعد التحقق من سجلات sap-plan في Supabase.')},response.status>=500||response.ok?502:response.status);
   plan=result.plan;
  }else{
  // Independently re-read the immutable original. Browser-supplied decoded
  // content is not trusted until it matches a fresh server-side readback.
  const original=await lieutenantFiles(new Request(new URL('/api/lieutenant-files?key='+encodeURIComponent(key),req.url)),env);
  if(!original.ok){await original.body?.cancel();return json({error:'تعذّر التحقق من الملف الأصلي المحفوظ.'},400);}
  const bytes=new Uint8Array(await original.arrayBuffer());
  const hash=createHash('sha256').update(bytes).digest('hex').slice(0,32);
  const storedHash=key.match(/^lieutenant\/(?:transfers|opening|balance|unified|other)__([a-f0-9]{32})__/)?.[1];
  if(hash!==storedHash)return json({error:'بصمة أصل ملف SAP لا تطابق أرشيفه. لم تُعالج أي بيانات.'},409);
  const filename=key.split('__').at(-1)||'';
  let decoded:string;
  try{decoded=decodeArchivedSapSource(bytes,filename)}
  catch{return json({error:'تعذّر التحقق المستقل من محتوى ملف SAP الأصلي. لم تُعالج أي بيانات.'},422);}
  if(decoded!==body.text)return json({error:'نص SAP لا يطابق الملف الأصلي المحفوظ. أعد فتح الأصل من «ملفات SAP» قبل المعالجة.'},409);
  plan=buildSapPlan(decoded,branches);
  }
  // Reuse only exact document fingerprints with a live queue/invoice key.
  // If an operator removed a record, its old receipt cannot hide missing data.
  if(plan.kind==='transfers'||plan.kind==='unified'){
   const schema=(await import('../../lib/reconciliation-schema.json')).default;
   await db().batch(schema.map(sql=>db().prepare(sql)));
   const receipts=await db().prepare(`SELECT r.number,r.fingerprint FROM sap_document_receipts r WHERE r.number IN (SELECT value FROM json_each(?)) AND (
    EXISTS(SELECT 1 FROM lieutenant_queue q WHERE q.transfer_no=r.number) OR
    EXISTS(SELECT 1 FROM transfer_keys k WHERE k.key=r.number))`).bind(JSON.stringify(plan.batches.filter(x=>x.action==='lieutenantImport').flatMap(x=>x.items).map(x=>(x as {number:string}).number))).all<{number:string;fingerprint:string}>();
   const known=new Map(receipts.results.map(x=>[x.number,x.fingerprint]));
   const unchanged=new Set<string>();
   const items=plan.batches.filter(x=>x.action==='lieutenantImport').flatMap(x=>x.items).filter(item=>{
    const number=(item as {number:string}).number;
    if(known.get(number)!==fingerprint(item))return true;
    unchanged.add(number);return false;
   });
   plan.batches=[...buildSapBatches('lieutenantImport',items),...plan.batches.filter(x=>x.action!=='lieutenantImport')];
   for(const doc of plan.documents)if(unchanged.has(doc.number)){doc.state='existing';doc.reason='نفس المستند دون تغيير؛ تحقق من وجوده في قاعدة البيانات';}
  }
  const {batches,...summary}=plan;
  const now=new Date().toISOString(),generation=crypto.randomUUID();
  if(existing){
   const current=await db().prepare('SELECT generation FROM sap_file_jobs WHERE key=?').bind(key).first<{generation:string}>();
   if(!current)return json({error:'تغيّرت حالة المعالجة؛ حدّث الشاشة.'},409);
   const allowed="key=? AND generation=? AND NOT EXISTS(SELECT 1 FROM sap_file_batches WHERE file_key=? AND state='running' AND lease>?)";
   const result=await db().batch([
    db().prepare('INSERT OR IGNORE INTO sap_job_history SELECT key,generation,version,kind,plan,total,updated FROM sap_file_jobs WHERE '+allowed).bind(key,current.generation,key,Date.now()),
    db().prepare('INSERT OR IGNORE INTO sap_batch_history SELECT file_key,?,idx,payload,state,result,error,duration FROM sap_file_batches WHERE file_key=? AND EXISTS(SELECT 1 FROM sap_file_jobs WHERE '+allowed+')').bind(current.generation,key,key,current.generation,key,Date.now()),
    db().prepare('UPDATE sap_file_jobs SET version=?,generation=?,kind=?,plan=?,total=?,updated=? WHERE '+allowed).bind(sapProcessorVersion,generation,plan.kind,JSON.stringify(summary),batches.length,now,key,current.generation,key,Date.now()),
    db().prepare('DELETE FROM sap_file_batches WHERE file_key=? AND EXISTS(SELECT 1 FROM sap_file_jobs WHERE key=? AND generation=?)').bind(key,key,generation),
    ...batches.map((batch,idx)=>db().prepare('INSERT OR IGNORE INTO sap_file_batches(file_key,idx,payload) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sap_file_jobs WHERE key=? AND generation=?)').bind(key,idx,JSON.stringify(batch),key,generation)),
   ]);
   if(!result[2].meta.changes)return json({error:'هناك معالجة أخرى نشطة. انتظر انتهاءها ثم أعد الفحص.'},409);
  }else await db().batch([
   db().prepare('INSERT OR IGNORE INTO sap_file_jobs(key,version,generation,kind,plan,total,updated) VALUES(?,?,?,?,?,?,?)').bind(key,sapProcessorVersion,generation,plan.kind,JSON.stringify(summary),batches.length,now),
   ...batches.map((batch,idx)=>db().prepare('INSERT OR IGNORE INTO sap_file_batches(file_key,idx,payload) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sap_file_jobs WHERE key=? AND generation=?)').bind(key,idx,JSON.stringify(batch),key,generation)),
  ]);
  return json({job:await readJob(key)});
 }
 if(body.action!=='batch'||!Number.isSafeInteger(body.index)||body.index<0)return json({error:'دفعة غير صالحة.'},400);
 const index=body.index as number,token=crypto.randomUUID(),now=Date.now();
 // Atomic database lease prevents duplicate concurrent tabs/requests. A killed
 // request can be resumed after lease expiry. Successful batches never rerun.
 const claimed=await db().prepare("UPDATE sap_file_batches SET state='running',token=?,lease=?,error='' WHERE file_key=? AND idx=? AND (state IN ('pending','failed') OR (state='running' AND lease<?)) RETURNING payload")
  .bind(token,now+120000,key,index,now).first<{payload:string}>();
 if(!claimed)return json({job:await readJob(key),busy:true});
 const started=performance.now();
 try{
  const batch=JSON.parse(claimed.payload) as SapBatch;
  const input=batch.action==='lieutenantImport'?{action:batch.action,sourceFile:key,transfers:batch.items}:{action:batch.action,items:batch.items};
  const response=await (batch.action==='lieutenantImport'?importTransfers:importAqaba)(new Request(req.url,{method:'POST',headers:{'Content-Type':'application/json','Origin':new URL(req.url).origin},body:JSON.stringify(input)}));
  const result=await response.json() as {error?:string;documents?:{number:string;state:string}[];added?:number;existing?:number;updated?:number;unchanged?:number};
  if(!response.ok)throw Error(result.error||'فشلت الدفعة: HTTP '+response.status);
  if(batch.action==='lieutenantImport'){
   const expected=batch.items as {number:string}[];
   if(result.documents?.length!==expected.length||new Set(result.documents.map(x=>x.number)).size!==expected.length||expected.some(x=>!result.documents?.some(doc=>doc.number===x.number&&['added','existing'].includes(doc.state))))throw Error('لم يؤكد الخادم كل مستندات الدفعة.');
  }else if((result.added||0)+(result.updated||0)+(result.unchanged||0)!==batch.items.length)throw Error('لم يؤكد الخادم كل بنود الدفعة.');
  await db().batch([
   ...(batch.action==='lieutenantImport'?[db().prepare(`INSERT INTO sap_document_receipts(number,fingerprint)
    SELECT json_extract(value,'$.number'),json_extract(value,'$.fingerprint') FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM sap_file_batches WHERE file_key=? AND idx=? AND token=?)
    ON CONFLICT(number) DO UPDATE SET fingerprint=excluded.fingerprint`)
    .bind(JSON.stringify(batch.items.map(item=>({number:(item as {number:string}).number,fingerprint:fingerprint(item)}))),key,index,token)]:[]),
   db().prepare("UPDATE sap_file_batches SET state='complete',result=?,duration=?,lease=0 WHERE file_key=? AND idx=? AND token=?").bind(JSON.stringify(result),Math.round(performance.now()-started),key,index,token),
   db().prepare('UPDATE sap_file_jobs SET updated=? WHERE key=?').bind(new Date().toISOString(),key),
  ]);
 }catch(e){
  await db().prepare("UPDATE sap_file_batches SET state='failed',error=?,duration=?,lease=0 WHERE file_key=? AND idx=? AND token=?").bind(e instanceof Error?e.message:'فشلت الدفعة.',Math.round(performance.now()-started),key,index,token).run();
 }
 return json({job:await readJob(key)});
}catch(e){return json({error:e instanceof Error?e.message:'تعذّرت معالجة الملف.'},e instanceof JsonRequestError?e.status:500);}}

