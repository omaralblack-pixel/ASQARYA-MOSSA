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
 if(method==='POST'){if(originals.has(key))return Response.json({error:'already exists'},{status:409});originals.set(key,String(init.body));return Response.json({ok:true});}
 return originals.has(key)?new Response(originals.get(key),{headers:{'Content-Type':'application/json'}}):Response.json({error:'not found'},{status:404});
};
const bytes=Uint8Array.from([255,254,65,0,66,0,9,0,49,0]);
async function upload(kind,date=''){
 const response=await handleInstitution(request('/api/lieutenant-files','POST',bytes,{'X-File-Name':encodeURIComponent('رصيد SAP.txt'),'X-File-Kind':kind,'X-Snapshot-Date':date}),env);
 assert.equal(response.status,200,await response.clone().text());return response.json();
}
const opening=await upload('opening','2026-11-01'),closing=await upload('balance','2026-11-15');assert.notEqual(opening.key,closing.key);
const duplicate=await upload('balance','2026-11-15');assert.equal(duplicate.duplicate,true);assert.equal(duplicate.key,closing.key);assert.equal(originals.size,2);
const list=await (await handleInstitution(request('/api/lieutenant-files?page=0'),env)).json();assert.equal(list.files.length,2);assert.deepEqual(list.files.map(x=>[x.kind,x.snapshotDate]),[['opening','2026-11-01'],['balance','2026-11-15']]);
for(const file of list.files){const opened=await handleInstitution(request('/api/lieutenant-files?key='+encodeURIComponent(file.key)),env);assert.deepEqual(new Uint8Array(await opened.arrayBuffer()),bytes);assert.ok(opened.headers.get('Content-Disposition').includes('filename*='));}
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
globalThis.fetch=previousFetch;
// Cloudflare edge/gateway sometimes responds with HTML or bad JSON for HTTP 503.
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
console.log('PASS: immutable original bytes, duplicate uploads, opening/closing dates independent of upload time, downloadable filenames, invalid dates, auth/same-origin guards, traversal rejection and full 205-file pagination.');
