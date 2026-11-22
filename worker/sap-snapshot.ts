import {lieutenantFiles} from './institution';
import {parseLieutenantTransfers} from '../app/lib/lieutenant';
import {decodeArchivedSapSource} from '../app/lib/sap-source-integrity';
import branches from '../app/branches.json';
import {sapProcessorVersion} from '../app/lib/sap-processor-version';

type ArchiveFile={key:string;name:string;kind:string;created:string};

/** Commit a fully processed daily SAP snapshot and retain rollback evidence.
 * Reconciliations and all manual decisions live in separate tables.
 */
export async function replaceSapSnapshot(request:Request,env:Cloudflare.Env):Promise<Response>{
 const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
 // The archive job's 0/0 batch counter is not evidence that its SAP
 // transfers were committed. Read the authoritative D1 snapshot pointer.
 if(request.method==='GET'){
  if(!env.DB)return reply({error:'قاعدة بيانات SAP غير متاحة.'},503);
  try{
   const row=await env.DB.prepare("SELECT value FROM settings WHERE key='sapCurrentSnapshot'")
    .first<{value:string}>();
   if(!row)return reply({snapshot:null});
   const source=JSON.parse(row.value) as {key?:unknown;created?:unknown;committed?:unknown;documents?:unknown};
   if(typeof source.key!=='string'||typeof source.documents!=='number'||
      !Number.isSafeInteger(source.documents)||source.documents<1)
    return reply({error:'سجل النسخة المعتمدة غير صالح؛ لا يمكن تأكيد الاعتماد.'},500);
   const count=await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM lieutenant_queue WHERE source_file=?'
   ).bind(source.key).first<{count:number}>();
   const snapshot={
    key:source.key,
    created:typeof source.created==='string'?source.created:'',
    committed:typeof source.committed==='string'?source.committed:'',
    documents:source.documents,
    activeCount:Number(count?.count||0),
   };
   const url=new URL(request.url);
   if(url.searchParams.get('rows')==='1'){
    if(url.searchParams.has('key')&&url.searchParams.get('key')!==source.key)
     return reply({error:'تغيّرت نسخة SAP أثناء القراءة؛ أعد الفحص.'},409);
    if(snapshot.activeCount!==snapshot.documents)return reply({error:'عدد ترحيلات D1 لا يطابق النسخة المعتمدة؛ الفحص غير مكتمل.'},409);
    const after=url.searchParams.get('after')||'';
    if(after.length>40)return reply({error:'مؤشر ترحيلات غير صالح.'},400);
    const result=await env.DB.prepare('SELECT transfer_no,payload FROM lieutenant_queue WHERE source_file=? AND transfer_no>? ORDER BY transfer_no LIMIT 51')
     .bind(source.key,after).all<{transfer_no:string;payload:string}>();
    const rows=result.results.slice(0,50);
    return reply({snapshot,rows,hasMore:result.results.length>50,next:rows.at(-1)?.transfer_no||null});
   }
   return reply({snapshot});
  }catch(error){
   console.error('Could not verify active SAP snapshot',error);
   return reply({error:'تعذّر التحقق من نسخة SAP المعتمدة في D1.'},503);
  }
 }
 if(request.method!=='POST'||request.headers.get('origin')!==new URL(request.url).origin)
  return reply({error:'طلب غير مسموح.'},403);
 try{
  const body=await request.json() as {action?:string;key:string;child?:string;children:string[];documents:number};
  if(!env.DB)throw Error('قاعدة البيانات غير متاحة.');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sap_snapshot_rows
    (root_key TEXT NOT NULL,child_key TEXT NOT NULL,number TEXT NOT NULL,doc_date TEXT NOT NULL,payload TEXT NOT NULL,
    PRIMARY KEY(root_key,number))`).run();
  // Indexed exact chunk-hash lookup: avoid scanning the full monthly snapshot
  // for each unchanged chunk (D1 row-read quota grows with file size).
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS sap_snapshot_rows_root_child ON sap_snapshot_rows(root_key,child_key)').run();
  const validChild=(key:string)=>typeof key==='string'&&
    (key===body.key&&body.key.startsWith('lieutenant/transfers__')||
      new RegExp('^lieutenant/transfers__[a-f0-9]{32}__sap-'+body.key.split('__')[1]+'-transfers-\\d{4}-of-\\d{4}\\.txt$').test(key));
  // Copy only byte-identical chunks from the ACTIVE, fully verified SAP
  // snapshot; every new chunk must already be archived and hash-verified.
  if(body.action==='reuse'){
   if(!/^lieutenant\/(unified|transfers)__[a-f0-9]{32}__[^/\\]{1,120}$/.test(body.key)||
      typeof body.child!=='string'||!validChild(body.child))
    return reply({error:'أصل أو جزء SAP غير صالح.'},400);
   const archived=await lieutenantFiles(new Request(
    new URL('/api/lieutenant-files?key='+encodeURIComponent(body.child),request.url)),env);
   if(!archived.ok)return reply({error:'تعذّر إثبات وجود الجزء الأصلي المحفوظ.'},409);
   const bytes=await archived.arrayBuffer();
   if(!bytes.byteLength||bytes.byteLength>350_000)
    return reply({error:'حجم جزء SAP غير صالح لإعادة الاستخدام.'},409);
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
    value=>value.toString(16).padStart(2,'0')).join('').slice(0,32);
   if(digest!==body.child.split('__')[1])
    return reply({error:'بصمة جزء SAP لا تطابق الأرشيف؛ لا يمكن إعادة استخدامه.'},409);
   const pointer=await env.DB.prepare("SELECT value FROM settings WHERE key='sapCurrentSnapshot'")
    .first<{value:string}>();
   const current=pointer?JSON.parse(pointer.value) as {
    key?:string;documents?:number;processorVersion?:number
   }:null;
   if(!current?.key||current.key===body.key||current.processorVersion!==sapProcessorVersion||
      !Number.isSafeInteger(current.documents)||!current.documents)
    return reply({reused:false,reason:'no_compatible_baseline'});
   const oldRows=await env.DB.prepare(
    'SELECT child_key,COUNT(*) AS count FROM sap_snapshot_rows WHERE root_key=? AND child_key GLOB ? GROUP BY child_key'
   ).bind(current.key,'lieutenant/transfers__'+digest+'__*').all<{child_key:string;count:number}>();
   const matches=oldRows.results.filter(row=>row.count>0);
   if(matches.length!==1)return reply({reused:false,reason:'no_unique_identical_chunk'});
   const old=matches[0];
   const previous=await env.DB.prepare('SELECT version,total FROM sap_file_jobs WHERE key=?')
    .bind(body.child).first<{version:number;total:number}>();
   if(previous){
    const staged=await env.DB.prepare(
     'SELECT COUNT(*) AS count FROM sap_snapshot_rows WHERE root_key=? AND child_key=?'
    ).bind(body.key,body.child).first<{count:number}>();
    if(previous.version===sapProcessorVersion&&previous.total===0&&
       Number(staged?.count)===Number(old.count))
     return reply({reused:true,staged:Number(old.count),alreadyStaged:true});
    return reply({reused:false,reason:'existing_processing_job'});
   }
   const now=new Date().toISOString();
   // Guard and both writes share one transaction: a concurrent activation
   // cannot silently mix rows from two different approved baselines.
   await env.DB.batch([
    env.DB.prepare(`SELECT json(CASE WHEN
     (SELECT json_extract(value,'$.key') FROM settings WHERE key='sapCurrentSnapshot')=?
     AND (SELECT json_extract(value,'$.processorVersion') FROM settings WHERE key='sapCurrentSnapshot')=?
     AND NOT EXISTS(SELECT 1 FROM sap_file_jobs WHERE key=?)
     AND NOT EXISTS(SELECT 1 FROM sap_snapshot_rows WHERE root_key=? AND child_key=?)
     THEN '{}' ELSE 'SAP baseline changed before reuse' END)`)
     .bind(current.key,sapProcessorVersion,body.child,body.key,body.child),
    env.DB.prepare(`INSERT INTO sap_file_jobs(key,version,generation,kind,plan,total,updated)
     VALUES(?,? ,?,'transfers',?,0,?)`).bind(body.child,sapProcessorVersion,crypto.randomUUID(),
     JSON.stringify({kind:'transfers',count:Number(old.count),issues:[],documents:[]}),now),
    env.DB.prepare(`INSERT INTO sap_snapshot_rows(root_key,child_key,number,doc_date,payload)
     SELECT ?,?,number,doc_date,payload FROM sap_snapshot_rows WHERE root_key=? AND child_key=?`)
     .bind(body.key,body.child,current.key,old.child_key),
   ]);
   return reply({reused:true,staged:Number(old.count)});
  }
  if(body.action==='stage'){
   if(!/^lieutenant\/(unified|transfers)__[a-f0-9]{32}__[^/\\]{1,120}$/.test(body.key)||!body.child||!validChild(body.child))
    return reply({error:'جزء SAP غير صالح.'},400);
   const response=await lieutenantFiles(new Request(new URL('/api/lieutenant-files?key='+encodeURIComponent(body.child),request.url)),env);
   if(!response.ok)throw Error('تعذّر استرجاع جزء SAP المحفوظ.');
   const bytes=new Uint8Array(await response.arrayBuffer());
   const savedBranches=await env.DB.prepare("SELECT value FROM settings WHERE key='branches'").first<{value:string}>();
   const scan=parseLieutenantTransfers(decodeArchivedSapSource(bytes,body.child),savedBranches?JSON.parse(savedBranches.value):branches);
   if(scan.issues.length||!scan.transfers.length)throw Error('تعذّر تجهيز الترحيلات: '+scan.issues.join('، '));
   const rows=scan.transfers.map(row=>({number:row.transfer.number,date:row.transfer.date,payload:JSON.stringify(row)}));
   await env.DB.batch([
    env.DB.prepare('DELETE FROM sap_snapshot_rows WHERE root_key=? AND child_key=?').bind(body.key,body.child),
    env.DB.prepare(`INSERT INTO sap_snapshot_rows(root_key,child_key,number,doc_date,payload)
      SELECT ?,?,json_extract(value,'$.number'),json_extract(value,'$.date'),json_extract(value,'$.payload') FROM json_each(?)`)
      .bind(body.key,body.child,JSON.stringify(rows)),
   ]);
   return reply({staged:rows.length});
  }
  if(!env.DB||!/^lieutenant\/(unified|transfers)__[a-f0-9]{32}__[^/\\]{1,120}$/.test(body.key)||
    !Array.isArray(body.children)||!body.children.length||body.children.length>200||
    !Number.isSafeInteger(body.documents)||body.documents<1)
   return reply({error:'بيانات نسخة SAP غير مكتملة.'},400);
  const hash=body.key.split('__')[1];
  if(new Set(body.children).size!==body.children.length||body.children.some(key=>typeof key!=='string'||
    !(key===body.key&&body.key.startsWith('lieutenant/transfers__')||
      new RegExp('^lieutenant/transfers__[a-f0-9]{32}__sap-'+hash+'-transfers-\\d{4}-of-\\d{4}\\.txt$').test(key))))
   return reply({error:'أجزاء SAP لا تنتمي إلى الأصل المحدد.'},400);
  if(body.key.startsWith('lieutenant/unified__')){
   const positions=body.children.map(key=>key.match(/-(\d{4})-of-(\d{4})\.txt$/));
   if(positions.some(match=>!match||Number(match[2])!==body.children.length)||
     new Set(positions.map(match=>Number(match![1]))).size!==body.children.length||
     positions.some(match=>Number(match![1])<1||Number(match![1])>body.children.length))
    return reply({error:'أجزاء الترحيلات غير مكتملة؛ لم يتم الاستبدال.'},409);
  }
  const files:ArchiveFile[]=[];
  let page:number|null=0;
  do{
   const response=await lieutenantFiles(new Request(new URL('/api/lieutenant-files?page='+page,request.url)),env);
   if(!response.ok)throw Error('تعذّر التحقق من أصول SAP المحفوظة.');
   const data=await response.json() as {files:ArchiveFile[];nextPage:number|null};
   files.push(...data.files);page=data.nextPage;
  }while(page!==null);
  const root=files.find(file=>file.key===body.key);
  if(!root||!root.created||body.children.some(key=>!files.some(file=>file.key===key)))
   return reply({error:'أصل SAP أو أحد أجزائه غير محفوظ.'},409);
  if(files.some(file=>file.kind===root.kind&&file.key!==root.key&&file.created>root.created))
   return reply({error:'توجد نسخة أحدث؛ استكمل النسخة الأحدث قبل الاستبدال.'},409);
  const keys=JSON.stringify(body.children);
  const jobs=await env.DB.prepare(`SELECT j.key,j.total,COUNT(b.idx) AS actual,
    SUM(CASE WHEN b.state='complete' THEN 1 ELSE 0 END) AS done
    FROM sap_file_jobs j LEFT JOIN sap_file_batches b ON b.file_key=j.key
    WHERE j.key IN (SELECT value FROM json_each(?)) GROUP BY j.key`).bind(keys)
   .all<{key:string;total:number;actual:number;done:number}>();
  if(jobs.results.length!==body.children.length||jobs.results.some(job=>job.total!==job.actual||job.done!==job.total))
   return reply({error:'لم تكتمل جميع دفعات النسخة الجديدة؛ النسخة السابقة ما زالت فعّالة.'},409);
  const source=`FROM sap_snapshot_rows WHERE root_key=? AND child_key IN (SELECT value FROM json_each(?))`;
  const counts=await env.DB.prepare(`SELECT COUNT(*) AS count,COUNT(DISTINCT number) AS uniqueCount ${source}`)
   .bind(body.key,keys).first<{count:number;uniqueCount:number}>();
  if(counts?.count!==body.documents||counts.uniqueCount!==body.documents)
   return reply({error:'عدد ترحيلات النسخة الجديدة غير مطابق؛ لم يتم الاستبدال.'},409);
  // This additive history is only written on a user-requested activation.
  // Keep the exact previous queue and pointer before atomically switching.
  await env.DB.batch([
   env.DB.prepare('CREATE TABLE IF NOT EXISTS sap_snapshot_history (id TEXT PRIMARY KEY,metadata TEXT NOT NULL,created TEXT NOT NULL)'),
   env.DB.prepare('CREATE TABLE IF NOT EXISTS sap_snapshot_history_rows (snapshot_id TEXT NOT NULL,transfer_no TEXT NOT NULL,doc_date TEXT NOT NULL,payload TEXT NOT NULL,source_file TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(snapshot_id,transfer_no))'),
  ]);
  const now=new Date().toISOString();
  const backupId=crypto.randomUUID();
  // One D1 transaction switches every SAP queue row together. Reviewed records,
  // invoice keys, branch exceptions and cancellation decisions are preserved.
  await env.DB.batch([
   env.DB.prepare(`SELECT json(CASE WHEN
    COALESCE((SELECT json_extract(value,'$.created') FROM settings WHERE key='sapCurrentSnapshot'),'')<=?
    AND (SELECT COUNT(*) ${source})=?
    AND NOT EXISTS(SELECT 1 FROM sap_file_batches WHERE file_key IN (SELECT value FROM json_each(?)) AND state<>'complete')
    THEN '{}' ELSE 'snapshot changed during commit' END)`)
    .bind(root.created,body.key,keys,body.documents,keys),
   env.DB.prepare("INSERT INTO sap_snapshot_history(id,metadata,created) VALUES(?,COALESCE((SELECT value FROM settings WHERE key='sapCurrentSnapshot'),'{}'),?)").bind(backupId,now),
   env.DB.prepare('INSERT INTO sap_snapshot_history_rows(snapshot_id,transfer_no,doc_date,payload,source_file,created) SELECT ?,transfer_no,doc_date,payload,source_file,created FROM lieutenant_queue').bind(backupId),
   env.DB.prepare('DELETE FROM lieutenant_queue'),
   env.DB.prepare(`INSERT INTO lieutenant_queue(transfer_no,doc_date,payload,source_file,created)
    SELECT number,doc_date,payload,?,? ${source}`).bind(body.key,now,body.key,keys),
   env.DB.prepare("INSERT INTO settings(key,value) VALUES('sapCurrentSnapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify({key:body.key,created:root.created,committed:now,documents:body.documents,processorVersion:sapProcessorVersion})),
   ...(root.kind==='unified'?[
    env.DB.prepare('DELETE FROM sap_file_batches WHERE file_key=?').bind(body.key),
    env.DB.prepare(`INSERT INTO sap_file_jobs(key,version,generation,kind,plan,total,updated)
      VALUES(?,1,?,'unified',?,0,?) ON CONFLICT(key) DO UPDATE SET
      version=excluded.version,generation=excluded.generation,kind=excluded.kind,plan=excluded.plan,total=0,updated=excluded.updated`)
     .bind(body.key,crypto.randomUUID(),JSON.stringify({kind:'unified',count:body.documents,issues:[],documents:[]}),now),
   ]:[]),
  ]);
  // Originals, completed batches and staging rows remain available for audit,
  // resume and rollback. Activation must never perform storage cleanup.
  return reply({committed:true,documents:body.documents,deleted:0,key:body.key,backupId});
 }catch(error){
  console.error('SAP snapshot replacement failed',error);
  return reply({error:error instanceof Error?error.message:'تعذّر استبدال نسخة SAP.'},500);
 }
}

