import {createHash} from 'node:crypto';
import {env} from 'cloudflare:workers';
import {desktopDevice} from '../../../worker/desktop-auth';
import {lieutenantFiles,savedImport} from '../../../worker/institution';
import {GET as readProcessing,POST as processSap} from '../sap-processing/route';
import {readJsonRequest,JsonRequestError} from '../../lib/json-request';
import {decodeArchivedSapSource} from '../../lib/sap-source-integrity';
import {splitUnifiedSapSource} from '../../lib/unified-sap-query';
import {desktopUnifiedChunks} from '../../lib/sap-desktop-chunks';
import {mergeSapShared} from '../../lib/sap-sync-shared';
import type {SapJob} from '../../lib/sap-processing';
export const dynamic='force-dynamic';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
class UpstreamError extends Error{constructor(message:string,readonly status:number){super(message);}}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function internal(req:Request,path:string,body?:unknown){return new Request(new URL(path,req.url),body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function checked(res:Response){
 const raw=await res.text();let data;
 try{data=JSON.parse(raw)}catch{throw Error('رد غير صالح: HTTP '+res.status+'؛ احتُفظ بالملف والدفعات السابقة.');}
 if(!res.ok)throw new UpstreamError(data.error||'HTTP '+res.status,[400,409,413,422].includes(res.status)?res.status:502);return data;
}
async function original(req:Request,key:string,expected:string){
 const res=await lieutenantFiles(internal(req,'/api/lieutenant-files?key='+encodeURIComponent(key)),env);
 if(!res.ok)throw Error('تعذّر استرجاع أصل SAP: HTTP '+res.status);
 const bytes=new Uint8Array(await res.arrayBuffer());
 if(hash(bytes)!==expected)throw Error('بصمة SHA-256 الكاملة لا تطابق الأصل المحفوظ.');
 return bytes;
}
async function archive(req:Request,name:string,kind:string,bytes:Uint8Array,date=''){
 return checked(await lieutenantFiles(new Request(new URL('/api/lieutenant-files',req.url),{method:'POST',headers:{'X-File-Name':encodeURIComponent(name),'X-File-Kind':kind,'X-Snapshot-Date':date},body:bytes as BodyInit}),env));
}
export async function GET(req:Request){try{
 if(!env.DB)return json({error:'D1 unavailable'},503);
 const device=await desktopDevice(req,env.DB);if(!device)return json({error:'Device unauthorized'},401);
 const sha=new URL(req.url).searchParams.get('sha256');
 if(!sha)return json({protocol:1,maxBytes:16*1024*1024,device});
 const file=await env.DB.prepare('SELECT * FROM sap_sync_files WHERE device_id=? AND sha256=?').bind(device,sha).first<{file_key:string;published:number}>();
 if(!file)return json({file:null});
 const state=await checked(await readProcessing(internal(req,'/api/sap-processing?key='+encodeURIComponent(file.file_key))));
 return json({file:{key:file.file_key,published:!!file.published,review:file.published&&!state.job?['تمت المعالجة المجزأة؛ راجع ملاحظات الأجزاء في ملفات SAP.']:[]},job:state.job});
}catch(e){return json({error:e instanceof Error?e.message:'SAP sync failed'},502);}}
export async function POST(req:Request){try{
 if(!env.DB)return json({error:'D1 unavailable'},503);
 const db=env.DB,device=await desktopDevice(req,db);if(!device)return json({error:'Device unauthorized'},401);
 const url=new URL(req.url),sha=url.searchParams.get('sha256')||'';
 if(!/^[a-f0-9]{64}$/.test(sha))return json({error:'Full SHA-256 required'},400);
 let file=await db.prepare('SELECT * FROM sap_sync_files WHERE device_id=? AND sha256=?').bind(device,sha)
  .first<{seq:number;file_key:string;name:string;published:number;saved_at:number}>();
 if(url.searchParams.get('action')==='upload'){
  if(file)return json({key:file.file_key,sha256:sha,duplicate:true});
  const savedAt=Number(req.headers.get('X-SAP-Saved-At'));
  if(!Number.isSafeInteger(savedAt)||savedAt<=0||savedAt>Date.now()+86400000)return json({error:'A valid source save timestamp is required'},400);
  const name=decodeURIComponent(req.headers.get('X-File-Name')||'');
  if(!/\.txt$/i.test(name)||name.length>100||/[\\/]/.test(name))return json({error:'Choose a TXT filename up to 100 characters'},400);
  // Bound the stream as well as Content-Length (which can be absent or forged).
  const reader=req.body?.getReader();if(!reader)return json({error:'Empty file'},400);
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
   if(length>16*1024*1024){await reader.cancel();return json({error:'File exceeds 16 MiB'},413);}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(!length||hash(bytes)!==sha)return json({error:'SHA-256 mismatch or empty file'},409);
  const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';
  const head=new TextDecoder(encoding).decode(bytes.subarray(0,4096)).replace(/^\uFEFF/,'').split(/\r?\n/)[0].split('\t');
  const saved=await archive(req,name,head.includes('RecordType')&&head.includes('DocumentNumber')?'unified':'other',bytes);
  await original(req,saved.key,sha); // Storage acknowledgement alone is insufficient.
  await db.prepare('INSERT OR IGNORE INTO sap_sync_files(device_id,sha256,file_key,name,saved_at,created) VALUES(?,?,?,?,?,?)')
   .bind(device,sha,saved.key,name,savedAt,new Date().toISOString()).run();
  return json({key:saved.key,sha256:sha,verified:true});
 }
 if(!file)return json({error:'Upload and verify the original first'},409);
 const body=await readJsonRequest(req,32*1024*1024);
 if(body.action==='start'||body.action==='batch'){
  // Never expose recheck/reset or arbitrary file keys to a device.
  return processSap(internal(req,'/api/sap-processing',{action:body.action,key:file.file_key,text:body.text,index:body.index}));
 }
 if(body.action!=='publish')return json({error:'Unsupported action'},400);
 if(file.published)return json({published:true,reused:true});
 const state=await checked(await readProcessing(internal(req,'/api/sap-processing?key='+encodeURIComponent(file.file_key))));
 let job=state.job as SapJob|null;
 if(!job&&Array.isArray(body.chunks)&&body.chunks.length<=128){
  const bytes=await original(req,file.file_key,sha),text=decodeArchivedSapSource(bytes,file.name);
  const expected=desktopUnifiedChunks(text).map(chunk=>hash(new TextEncoder().encode(chunk)));
  if(expected.length!==body.chunks.length||expected.some((value,i)=>value!==body.chunks[i]))return json({error:'Chunk manifest does not match the complete original'},409);
  const children=await db.prepare(`SELECT f.sha256,j.total,j.plan,COUNT(b.idx) AS actual,
   SUM(CASE WHEN b.state='complete' THEN 1 ELSE 0 END) AS done
   FROM sap_sync_files f JOIN sap_file_jobs j ON j.key=f.file_key
   LEFT JOIN sap_file_batches b ON b.file_key=j.key
   WHERE f.device_id=? AND f.sha256 IN (SELECT value FROM json_each(?)) GROUP BY f.sha256`)
   .bind(device,JSON.stringify(expected)).all<{sha256:string;total:number;actual:number;done:number;plan:string}>();
  if(children.results.length!==expected.length||children.results.some(row=>row.total!==row.actual||row.total!==(row.done||0)))return json({error:'Complete all verified child batches first'},409);
  const issues=[...new Set(children.results.flatMap(row=>(JSON.parse(row.plan) as {issues:string[]}).issues))];
  job={kind:'unified',done:0,total:0,failed:0,running:0,issues,status:issues.length?'review':'complete'} as SapJob;
 }
 if(!job||job.done!==job.total||job.failed||job.running)return json({error:'Complete pending batches before publication'},409);
 // Serialize compatibility-view publication across devices. An older retry can
 // never overwrite a newer snapshot. The lock expires after a lost request.
 const token=crypto.randomUUID();
 const lock=await db.prepare('UPDATE sap_sync_publication SET token=?,lease=? WHERE id=1 AND lease<? RETURNING last_seq,last_saved_at')
  .bind(token,Date.now()+120000,Date.now()).first<{last_seq:number;last_saved_at:number}>();
 if(!lock)return json({error:'Publication busy; retry later'},409);
 try{
  const bytes=await original(req,file.file_key,sha),text=decodeArchivedSapSource(bytes,file.name);
  const parts=job.kind==='unified'?splitUnifiedSapSource(text):null;
  if(parts)job.issues=[...new Set([...job.issues,...parts.warnings])];
  const transferText=parts?.transfers||(job.kind==='transfers'?text:'');
  if(parts){
   for(const part of [{kind:'transfers',text:parts.transfers,date:'',count:parts.counts.TRANSFER},
    {kind:'opening',text:parts.opening,date:parts.from,count:parts.counts.OPENING},
    {kind:'balance',text:parts.closing,date:parts.to,count:parts.counts.CLOSING}]){
    if(part.count)await archive(req,'sync-'+sha.slice(0,16)+'-'+part.kind+'.txt',part.kind,new TextEncoder().encode(part.text),part.date);
   }
  }else if(job.kind==='transfers')await archive(req,file.name,'transfers',bytes);
  let sharedKey:string|undefined;
  if(transferText.trim()&&(parts?parts.counts.TRANSFER>0:true)){
   const previous=await checked(await savedImport(internal(req,'/api/sap-import'),env));
   const combined=(lock.last_saved_at>file.saved_at||(lock.last_saved_at===file.saved_at&&lock.last_seq>file.seq))&&previous?.text?mergeSapShared(transferText,previous.text):mergeSapShared(previous?.text,transferText);
   sharedKey='sync-views/'+token+'.json';
   const response=await savedImport(new Request(new URL('/api/sap-import',req.url),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,text:combined})}),env,sharedKey);
   if(!response.ok)throw Error('تعذّر تحديث الكشف المشترك: HTTP '+response.status);
  }
  // Lease ownership is rechecked before committing the visible revision.
  const result=await db.batch([
   db.prepare('UPDATE sap_sync_files SET published=1 WHERE seq=? AND EXISTS(SELECT 1 FROM sap_sync_publication WHERE id=1 AND token=?)').bind(file.seq,token),
   db.prepare('UPDATE sap_sync_publication SET last_seq=CASE WHEN ?>last_saved_at OR (?=last_saved_at AND ?>last_seq) THEN ? ELSE last_seq END,last_saved_at=MAX(last_saved_at,?),revision=revision+1,shared_key=COALESCE(?,shared_key) WHERE id=1 AND token=?').bind(file.saved_at,file.saved_at,file.seq,file.seq,file.saved_at,sharedKey||null,token),
  ]);
  if(!result[0].meta.changes)throw Error('Publication lease lost; retry to verify');
  return json({published:true,review:job.issues,status:job.status});
 }finally{await db.prepare("UPDATE sap_sync_publication SET token='',lease=0 WHERE id=1 AND token=?").bind(token).run();}
}catch(e){return json({error:e instanceof Error?e.message:'SAP sync failed; local copy retained'},e instanceof JsonRequestError||e instanceof UpstreamError?e.status:502);}}
