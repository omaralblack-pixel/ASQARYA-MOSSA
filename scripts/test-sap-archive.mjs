import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {createHmac} from 'node:crypto';
import ts from 'typescript';
const cache=new Map();function load(file){file=resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('exports','require',js)(exports,name=>name.startsWith('.')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name));return exports;}
const {handleInstitution}=load('worker/institution.ts');
const env={SUPABASE_URL:'https://storage.test',SUPABASE_STORAGE_SECRET:'test-storage-only',INSTITUTION_SESSION_SECRET:'x'.repeat(32)};
const value=Date.now()+100000+'.'+'a'.repeat(32),signature=createHmac('sha256',env.INSTITUTION_SESSION_SECRET).update(value).digest('hex');
const cookie='__Host-institution='+value+'.'+signature,origin='https://example.test';
const request=(path,method='GET',body,headers={})=>new Request(origin+path,{method,headers:{Cookie:cookie,Origin:origin,...headers},body});
const originals=new Map();const previousFetch=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input)),method=init.method||'GET';assert.equal(url.hostname,'storage.test');
 if(url.pathname.includes('/list/')){
  const query=JSON.parse(init.body);const rows=[...originals].map(([key])=>({name:key.replace(/^lieutenant\//,''),created_at:'2026-11-15T19:00:00Z',metadata:{size:100}}));
  return Response.json(rows.slice(query.offset,query.offset+query.limit));
 }
 if(method==='DELETE'){const prefixes=JSON.parse(init.body).prefixes;return Response.json(prefixes.filter(key=>originals.delete(key)).map(name=>({name})));}
 const key=decodeURIComponent(url.pathname.split('/institution-sap/')[1]||'');
 if(method==='POST'){
  // Supabase rejects Unicode in object storage key with HTTP 400 InvalidKey.
  if([...key].some(ch=>ch.charCodeAt(0)>127))return Response.json({code:'InvalidKey',error:'InvalidKey',message:'Invalid storage key'},{status:400});
  if(originals.has(key))return Response.json({error:'already exists'},{status:409});
  originals.set(key,String(init.body));return Response.json({ok:true});
 }
 return originals.has(key)?new Response(originals.get(key),{headers:{'Content-Type':'application/json'}}):Response.json({error:'not found'},{status:404});
};
const bytes=Uint8Array.from([255,254,65,0,66,0,9,0,49,0]);
async function upload(kind,date='',name='رصيد SAP.txt'){
 const response=await handleInstitution(request('/api/lieutenant-files','POST',bytes,{'X-File-Name':encodeURIComponent(name),'X-File-Kind':kind,'X-Snapshot-Date':date}),env);
 assert.equal(response.status,200,await response.clone().text());return response.json();
}
const opening=await upload('opening','2026-11-01'),closing=await upload('balance','2026-11-15');
assert.notEqual(opening.key,closing.key);
assert.match(opening.key,/saputf8-[A-Za-z0-9.-]+$/);
assert.ok([...opening.key].every(ch=>ch.charCodeAt(0)<128),'Supabase path contains ASCII only');
const duplicate=await upload('balance','2026-11-15');assert.equal(duplicate.duplicate,true);assert.equal(duplicate.key,closing.key);assert.equal(originals.size,2);

const guardedDb={prepare:()=>({bind:()=>({first:async()=>({total:3,done:1})})})};
const blocked=await handleInstitution(request('/api/lieutenant-files','DELETE',JSON.stringify({key:closing.key})),{...env,DB:guardedDb});
assert.equal(blocked.status,409,'An original with 1/3 completed SAP batches must be undeletable');
assert.equal(originals.size,2,'Protected SAP originals remain in Supabase');

const list=await (await handleInstitution(request('/api/lieutenant-files?page=0'),env)).json();assert.equal(list.files.length,2);assert.deepEqual(list.files.map(x=>[x.kind,x.snapshotDate]),[['opening','2026-11-01'],['balance','2026-11-15']]);
assert.ok(list.files.every(x=>x.name==='رصيد SAP.txt'),'Original Arabic filename must be displayed in file archive');
for(const file of list.files){const opened=await handleInstitution(request('/api/lieutenant-files?key='+encodeURIComponent(file.key)),env);assert.deepEqual(new Uint8Array(await opened.arrayBuffer()),bytes);assert.ok(opened.headers.get('Content-Disposition').includes(encodeURIComponent(file.name)),
  'Download must preserve Unicode filename in RFC 5987 header');}
const invalidDate=await handleInstitution(request('/api/lieutenant-files','POST',bytes,{'X-File-Name':'stock.txt','X-File-Kind':'balance','X-Snapshot-Date':'2026-02-30'}),env);assert.equal(invalidDate.status,400);
const unauth=await handleInstitution(new Request(origin+'/api/sap-processing'),env);assert.equal(unauth.status,401);
const crossOrigin=await handleInstitution(request('/api/sap-processing','POST','{}',{Origin:'https://evil.test'}),env);assert.equal(crossOrigin.status,403);
const authenticated=await handleInstitution(request('/api/sap-processing'),env);assert.equal(authenticated,undefined,'authenticated requests continue through the same gateway');
const traversal=await handleInstitution(request('/api/lieutenant-files','DELETE',JSON.stringify({key:'lieutenant/../current.json'})),env);assert.equal(traversal.status,400);assert.equal(originals.size,2);
// Pagination is shared by every report and must not omit archives older than 100.
for(let i=0;i<203;i++)originals.set('lieutenant/other__'+'a'.repeat(32)+'__'+i+'.txt','{}');
const {listSapFiles}=load('app/lib/sap-files-client.ts');
const storageFetch=globalThis.fetch;
globalThis.fetch=async(path,init)=>String(path).startsWith('https://storage.test')?storageFetch(path,init):handleInstitution(request(String(path)),env);
assert.equal((await listSapFiles()).length,205);
// A unified SAP source is archived with an explicit kind and its original
// filename/hash; old 'other' originals remain untouched for recovery.
const unified=await upload('unified');
assert.ok(unified.key.startsWith('lieutenant/unified__'));
const unifiedArchive=await handleInstitution(request('/api/lieutenant-files?page=2'),env);
assert.equal(unifiedArchive.status,200);
const unifiedList=await unifiedArchive.json();
assert.ok(unifiedList.files.some(file=>file.key===unified.key&&file.kind==='unified'));
const restoredUnified=await handleInstitution(request('/api/lieutenant-files?key='+encodeURIComponent(unified.key)),env);
assert.equal(restoredUnified.status,200);
assert.deepEqual(new Uint8Array(await restoredUnified.arrayBuffer()),bytes);
// Exact user regression: Arabic name previously returned HTTP 502 for a
// Supabase Storage 400 InvalidKey; preserve bytes, display name and idempotence.
const arabic=await upload('unified','','كويري 18.txt');
assert.ok([...arabic.key].every(ch=>ch.charCodeAt(0)<128));
assert.ok(!arabic.key.includes('كويري'));
const again=await upload('unified','','كويري 18.txt');
assert.equal(again.key,arabic.key);
assert.equal(again.duplicate,true);
const decodedList=await (await handleInstitution(request('/api/lieutenant-files?page=2'),env)).json();
assert.ok(decodedList.files.some(x=>x.key===arabic.key&&x.name==='كويري 18.txt'));
const downloadedArabic=await handleInstitution(request('/api/lieutenant-files?key='+encodeURIComponent(arabic.key)),env);
assert.equal(downloadedArabic.status,200);
assert.deepEqual(new Uint8Array(await downloadedArabic.arrayBuffer()),bytes);
assert.ok(downloadedArabic.headers.get('Content-Disposition').includes(encodeURIComponent('كويري 18.txt')));
globalThis.fetch=previousFetch;
// Cloudflare edge/gateway sometimes responds with HTML or bad JSON for HTTP 503.
const sapScreen=fs.readFileSync('app/reconciliation/SapFiles.tsx','utf8');
assert.ok(sapScreen.includes('await verifyArchivedSource(saved.key,bytes)'),
 'Original is read back from Supabase before D1 processing');
assert.ok(sapScreen.indexOf('await verifyArchivedSource(saved.key,bytes)')<sapScreen.indexOf('await processFile(stored,text)'),
 'Persist and verify immutable original before starting costly SAP import');
assert.ok(sapScreen.includes('olderPartial')&&sapScreen.includes('olderSnapshotNotice')&&
 !sapScreen.includes('if(otherPartial)'),
 'A newer daily SAP snapshot must process independently of unfinished older same-name jobs');
assert.ok(sapScreen.includes('orphanActive')&&sapScreen.includes('orphanHistory'),
 'Incomplete orphan sources must be prioritized over completed historical D1 jobs');
assert.ok(sapScreen.includes("file.kind==='other'&&opened?.file.key===file.key&&isUnifiedSapSource(opened.text)"),
 'Legacy other-kind originals must display their verified unified source type');
assert.ok(sapScreen.includes("['transfers','balance','opening','unified'].includes(detected)"),
 'New unified originals must be saved under their own archive kind');
assert.ok(sapScreen.includes('archiveUnlistedJobs')&&sapScreen.includes('verifyUnlistedOriginal'),
 'Expose D1 processing records missing from the Supabase archive listing');
assert.ok(sapScreen.includes('state.done<state.total'),
 'Do not allow UI to delete incomplete originals');
console.log('PASS: verified source upload order, D1 orphan reconciliation and protected partial-job originals.');

// The UI must show the failing operation, not a raw JSON.parse SyntaxError.
const {readSapJson}=load('app/lib/sap-files-client.ts');
const html503=new Response('<!DOCTYPE html><html><title>Service unavailable</title></html>',{
 status:503,headers:{'Content-Type':'text/html'}});
await assert.rejects(()=>readSapJson(html503,'استكمال دفعة SAP رقم 2'),
 error=>error instanceof Error&&/HTTP 503/.test(error.message)&&
  /استكمال دفعة SAP رقم 2/.test(error.message)&&/HTML/.test(error.message));
const invalidJson=new Response('<html>bad JSON</html>',{
 status:503,headers:{'Content-Type':'application/json'}});
await assert.rejects(()=>readSapJson(invalidJson,'تحديث الحالة'),
 error=>error instanceof Error&&/HTTP 503/.test(error.message)&&/ليس JSON صالحًا/.test(error.message));
const validError=Response.json({error:'قاعدة D1 غير مربوطة'},{status:503});
await assert.rejects(()=>readSapJson(validError,'قراءة المعالجة'),
 error=>error instanceof Error&&/قاعدة D1 غير مربوطة/.test(error.message));
assert.deepEqual(await readSapJson(Response.json({job:{done:1,total:3}}),'حالة المعالجة'),
 {job:{done:1,total:3}});
const screen=fs.readFileSync('app/reconciliation/SapFiles.tsx','utf8');
assert.ok(screen.includes('const saved=await readSapJson<'), 'SAP upload must not blindly parse a 503 HTML page');
assert.ok(screen.includes('let archiveWarning=')&&screen.includes('await archiveUnifiedParts('),
 'A derived snapshot archive failure must not block completing durable SAP batches');
assert.ok(screen.indexOf('for(const batch of state.batches.filter')<
 screen.indexOf('let archiveWarning='),'Archive failure cannot run before batch resume');
console.log('PASS: SAP HTML 503, invalid JSON, actionable endpoint diagnosis, partial batch resume and archive isolation.');

// A 503 can precede a batch write or hide an already-committed write. Probe
// durable state first; retry only confirmed pending work and keep lease guards.
const {sapRequest}=load('app/lib/sap-files-client.ts');
const batchKey='lieutenant/transfers__'+'c'.repeat(32)+'__retry.txt';
const batchBody={action:'batch',key:batchKey,index:0};
const batchJob=state=>({key:batchKey,total:1,done:state==='complete'?1:0,
 batches:[{idx:0,state,error:'',duration:0}]});
const batchUrl='/api/sap-processing';
const previousTimer=globalThis.setTimeout;
// Advance backoff only; request deadlines must remain real timers.
globalThis.setTimeout=(fn,ms,...args)=>ms>=10_000?previousTimer(fn,ms,...args):(queueMicrotask(fn),0);
try{
 for(const state of ['complete','running','failed','pending']){
  const calls=[];let posts=0;
  globalThis.fetch=async(url,init)=>{
   const post=init?.method==='POST';calls.push(post?'POST':'GET');
   if(!post){assert.equal(String(url),batchUrl+'?key='+encodeURIComponent(batchKey));return Response.json({job:batchJob(state)});}
   assert.deepEqual(JSON.parse(init.body),batchBody);
   if(++posts===1)return new Response('<html>503</html>',{status:503});
   return Response.json({job:batchJob('complete')});
  };
  const resumed=await sapRequest(batchUrl,batchBody);
  assert.deepEqual(calls,state==='pending'?['POST','GET','POST']:['POST','GET']);
  assert.equal(resumed.job.batches[0].state,state==='pending'?'complete':state);
  assert.equal(!!resumed.busy,state==='running');
 }
 let posts=0,reads=0;
 globalThis.fetch=async(_,init)=>{
  if(init?.method==='POST'){posts++;return new Response('<html>503</html>',{status:503});}
  reads++;return Response.json({job:batchJob('pending')});
 };
 await assert.rejects(()=>sapRequest(batchUrl,batchBody),/HTTP 503/);
 assert.equal(posts,3,'Transient batch retries are bounded');assert.equal(reads,3);
 posts=0;reads=0;
 globalThis.fetch=async(_,init)=>{
  if(init?.method==='POST')posts++;else reads++;
  return new Response('<html>503</html>',{status:503});
 };
 await assert.rejects(()=>sapRequest(batchUrl,batchBody),/HTTP 503/);
 assert.equal(posts,1,'Do not repeat a write when durable state cannot be read');assert.equal(reads,3);
 for(const status of [400,401,403,409,422,546]){
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:'requires review'},{status});};
  await assert.rejects(()=>sapRequest(batchUrl,batchBody));
  assert.equal(calls,1,'Do not retry authentication, validation, conflicts or CPU-limit errors');
 }
 posts=0;
 globalThis.fetch=async(_,init)=>{
  if(init?.method==='POST'){posts++;throw new TypeError('network unavailable');}
  return Response.json({job:batchJob('complete')});
 };
 assert.equal((await sapRequest(batchUrl,batchBody)).job.done,1);
 assert.equal(posts,1,'A dropped response after commit cannot duplicate the write');
}finally{globalThis.fetch=previousFetch;globalThis.setTimeout=previousTimer;}
console.log('PASS: bounded SAP batch retries, committed-response readback, active leases, failed-batch review, network recovery and unavailable-state protection.');
console.log('PASS: immutable original bytes, duplicate uploads, opening/closing dates independent of upload time, downloadable filenames, invalid dates, auth/same-origin guards, traversal rejection and full 205-file pagination.');
