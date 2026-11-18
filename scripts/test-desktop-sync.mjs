import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,createHmac} from 'node:crypto';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
const sqlite=new DatabaseSync(':memory:');
const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values)},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}}});
const DB={prepare:sql=>wrap(sql),async batch(queries){sqlite.exec('BEGIN');try{const out=[];for(const q of queries)out.push(await q.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const env={DB,SUPABASE_URL:'https://storage.test',SUPABASE_STORAGE_SECRET:'test-only',INSTITUTION_SESSION_SECRET:'s'.repeat(32)};
const cache=new Map();
function load(file){file=resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('exports','require',js)(exports,name=>name==='cloudflare:workers'?{env}:name.startsWith('.')&&!name.endsWith('.json')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name));return exports;
}
const gateway=load('worker/institution.ts'),route=load('app/api/desktop-sync/route.ts');
const {buildSapPlan}=load('app/lib/sap-processing.ts');
const {decodeArchivedSapSource}=load('app/lib/sap-source-integrity.ts');
const {parseLieutenantTransfers}=load('app/lib/lieutenant.ts');
const branches=JSON.parse(fs.readFileSync('app/branches.json','utf8'));
const objects=new Map();let planFailure=false,stealLease=false,originalFailure=false;
const priorFetch=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));assert.equal(url.hostname,'storage.test');
 if(url.pathname==='/functions/v1/sap-plan'){
  if(planFailure){planFailure=false;return new Response('<html>compute limit</html>',{status:546});}
  const {key,textHash}=JSON.parse(init.body),wrapped=JSON.parse(objects.get(key));
  const text=decodeArchivedSapSource(Buffer.from(wrapped.data,'base64'),key.split('__').at(-1));
  assert.equal(createHash('sha256').update(text).digest('hex'),textHash);
  return Response.json({plan:buildSapPlan(text,branches)});
 }
 const key=decodeURIComponent(url.pathname.split('/institution-sap/')[1]||'');
 if(init.method==='POST'){
  if(objects.has(key)&&init.headers['x-upsert']==='false')return Response.json({error:'already exists'},{status:409});
  objects.set(key,String(init.body));
  if(stealLease&&key.startsWith('sync-views/')){stealLease=false;sqlite.exec("UPDATE sap_sync_publication SET token='other-owner' WHERE id=1");}
  return Response.json({ok:true});
 }
 if(originalFailure&&key.startsWith('lieutenant/')){originalFailure=false;return new Response('<html>offline</html>',{status:502});}
 return objects.has(key)?new Response(objects.get(key),{headers:{'Content-Type':'application/json'}}):Response.json({code:'NoSuchKey'},{status:404});
};
const origin='https://example.test';
const value=Date.now()+3600000+'.'+'a'.repeat(32),cookie='__Host-institution='+value+'.'+createHmac('sha256',env.INSTITUTION_SESSION_SECRET).update(value).digest('hex');
async function managed(method='GET',body,token){return gateway.handleInstitution(new Request(origin+'/api/desktop-sync/devices',{method,headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{Cookie:cookie}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);}
const paired=await (await managed('POST',{name:'SAP test PC'})).json();const token=paired.token;
assert.match(token,/^sapds_[a-f0-9]{64}$/);
assert.notEqual(sqlite.prepare('SELECT token_hash FROM sap_sync_devices').get().token_hash,token);
assert.equal(JSON.stringify(await (await managed()).json()).includes(token),false);
assert.equal((await managed('POST',{name:'unauthorized'},token)).status,401);
const savedTimes=new Map();let savedClock=Date.now()-100000;
async function call(sha,body,raw,name='SAP.txt',auth=token){
 if(raw&&!savedTimes.has(sha))savedTimes.set(sha,savedClock+=1000);
 const query=sha?'?sha256='+sha+(raw?'&action=upload':''):'';
 const req=new Request(origin+'/api/desktop-sync'+query,{method:body||raw?'POST':'GET',headers:{Authorization:'Bearer '+auth,...(raw?{'X-File-Name':encodeURIComponent(name),'X-SAP-Saved-At':String(savedTimes.get(sha))}:{'Content-Type':'application/json'})},...(raw?{body:raw}:body?{body:JSON.stringify(body)}:{})});
 const guard=await gateway.handleInstitution(req,env);return guard||route[req.method](req);
}
assert.equal((await call('',null,null,'', 'sapds_'+'0'.repeat(64))).status,401);
assert.equal((await call('')).status,200);
const denied=await gateway.handleInstitution(new Request(origin+'/api/reconcile',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:origin},body:'{}'}),env);assert.equal(denied.status,401);
const header='Document Number\tDocument Date\tBranch Code\tBranch Name\tRemarks\tItem No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const row=(number,quantity=1)=>[number,'2026-11-18','21','السرو','','DAR00005','كريمة',quantity,'Piece','001','011'].join('\t');
const text=[header,...Array.from({length:121},(_,i)=>row(2617000+i))].join('\n');
const bytes=new TextEncoder().encode(text),sha=createHash('sha256').update(bytes).digest('hex');
assert.equal((await call('a'.repeat(64),null,bytes)).status,409);
originalFailure=true;assert.equal((await call(sha,null,bytes)).status,502);
assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sap_sync_files').get().n,0,'uncertain archive readback must not be acknowledged');
const stored=await (await call(sha,null,bytes)).json();assert.ok(stored.verified);assert.equal(stored.sha256,sha);
assert.equal((await (await call(sha,null,bytes)).json()).duplicate,true);
assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sap_sync_files').get().n,1);
planFailure=true;const failedPlan=await call(sha,{action:'start',text});assert.equal(failedPlan.status,502);assert.match((await failedPlan.json()).error,/546/);
assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sap_file_jobs').get().n,0,'failed planner cannot erase or partially create job');
let state=await (await call(sha,{action:'start',text})).json();assert.equal(state.job.total,3);
state=await (await call(sha,{action:'batch',index:0})).json();assert.equal(state.job.done,1);
const oldGeneration=sqlite.prepare('SELECT generation FROM sap_file_jobs WHERE key=?').get(stored.key).generation;
const nextText=text.replace('كريمة\t1','كريمة\t2')+'\n'+row(2617999),nextBytes=new TextEncoder().encode(nextText),nextSha=createHash('sha256').update(nextBytes).digest('hex');
const next=await (await call(nextSha,null,nextBytes)).json();assert.notEqual(next.key,stored.key);
state=await (await call(nextSha,{action:'start',text:nextText})).json();
assert.equal((await (await call(sha)).json()).job.done,1,'daily version must not reset earlier 1/3 job');
for(const b of state.job.batches)assert.equal((await call(nextSha,{action:'batch',index:b.idx})).status,200);
assert.equal((await (await call(nextSha,{action:'publish'})).json()).published,true);
const shared=await (await gateway.savedImport(new Request(origin+'/api/sap-import'),env)).json();
assert.equal(parseLieutenantTransfers(shared.text,branches).transfers.length,122);
assert.match(shared.text,/كريمة\t2/);
const pointer=sqlite.prepare('SELECT shared_key FROM sap_sync_publication').get().shared_key;assert.ok(pointer.startsWith('sync-views/'));
// Explicit start of existing partial work resumes without parsing/resetting it.
state=await (await call(sha,{action:'start',text:'not trusted',recheck:true})).json();assert.equal(state.job.done,1);
for(const b of state.job.batches.filter(b=>b.state!=='complete'))await call(sha,{action:'batch',index:b.idx});
assert.equal(sqlite.prepare('SELECT generation FROM sap_file_jobs WHERE key=?').get(stored.key).generation,oldGeneration);
assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM lieutenant_queue').get().n,122);
assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM reconciliations').get().n,0,'device cannot create invoice groups');
assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM lieutenant_cancellation_decisions').get().n,0);
// Old retry may supplement evidence, but cannot replace newer document contents.
assert.equal((await (await call(sha,{action:'publish'})).json()).published,true);
const afterOld=await (await gateway.savedImport(new Request(origin+'/api/sap-import'),env)).json();
assert.match(afterOld.text,/كريمة\t2/);assert.equal(parseLieutenantTransfers(afterOld.text,branches).transfers.length,122);
assert.equal((await (await call(sha,{action:'publish'})).json()).reused,true);
// A stale publisher may finish an immutable Storage write but cannot move pointer.
const thirdBytes=new TextEncoder().encode(text+'\n'+row(2618000)),thirdSha=createHash('sha256').update(thirdBytes).digest('hex');
await call(thirdSha,null,thirdBytes);state=await (await call(thirdSha,{action:'start',text:new TextDecoder().decode(thirdBytes)})).json();
for(const b of state.job.batches)await call(thirdSha,{action:'batch',index:b.idx});
const beforeSteal=sqlite.prepare('SELECT shared_key FROM sap_sync_publication').get().shared_key;
stealLease=true;assert.equal((await call(thirdSha,{action:'publish'})).status,502);
assert.equal(sqlite.prepare('SELECT shared_key FROM sap_sync_publication').get().shared_key,beforeSteal);
assert.equal((await (await call(thirdSha)).json()).file.published,false);
sqlite.exec("UPDATE sap_sync_publication SET lease=0,token='' WHERE id=1");
assert.equal((await (await call(thirdSha,{action:'publish'})).json()).published,true);
const revision=await (await gateway.handleInstitution(new Request(origin+'/api/sap-sync-revision',{headers:{Cookie:cookie}}),env)).json();assert.ok(revision.revision>=3);
// Unified exports deliberately contain equivalent English/Arabic aliases.
// Publication must preserve their actual stock dates and support shared readers.
const {unifiedSapQuery}=load('app/lib/unified-sap-query.ts');
const fields=[...unifiedSapQuery('2026-11-01','2026-11-18').split('\nUNION ALL\n')[0].matchAll(/ AS "([^"]+)"/g)].map(m=>m[1]);
const urow=object=>fields.map(field=>String(object[field]??'')).join('\t');
const unified=[fields.join('\t'),urow({RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:'2026-11-18'}),
 urow({RecordType:'TRANSFER',DocumentNumber:'2619000',DocumentDate:'2026-11-18',LineNumber:1,ItemCode:'DAR00005',ItemName:'كريمة',Quantity:3,Unit:'Piece',FromWarehouse:'001',ToWarehouse:'011',Remarks:'السرو',CancellationStatus:'N'}),
 urow({RecordType:'OPENING',DocumentDate:'2026-11-01',ItemCode:'DAR00005',ItemName:'كريمة',Unit:'Piece',Warehouse:'011',StockQuantity:5}),
 urow({RecordType:'CLOSING',DocumentDate:'2026-11-18',ItemCode:'DAR00005',ItemName:'كريمة',Unit:'Piece',Warehouse:'011',StockQuantity:8})].join('\n');
const ub=new TextEncoder().encode(unified),us=createHash('sha256').update(ub).digest('hex');
await call(us,null,ub);state=await (await call(us,{action:'start',text:unified})).json();assert.equal(state.job.kind,'unified');
for(const b of state.job.batches)await call(us,{action:'batch',index:b.idx});
const up=await call(us,{action:'publish'});assert.equal(up.status,200,await up.clone().text());assert.equal((await up.json()).published,true);
assert.ok([...objects.keys()].some(k=>/^lieutenant\/opening__.*__2026-11-01__/.test(k)));
assert.ok([...objects.keys()].some(k=>/^lieutenant\/balance__.*__2026-11-18__/.test(k)));
const merged=await (await gateway.savedImport(new Request(origin+'/api/sap-import'),env)).json();assert.equal(parseLieutenantTransfers(merged.text,branches).transfers.length,124);
// An old file can arrive LAST after an offline upload. Source save time,
// not arrival sequence, protects newer SAP contents from that late retry.
const beforeLateText=await (await gateway.savedImport(new Request(origin+'/api/sap-import'),env)).json();
const lateText=text.replace('كريمة\t1','كريمة\t7'),lateBytes=new TextEncoder().encode(lateText),lateSha=createHash('sha256').update(lateBytes).digest('hex');
savedTimes.set(lateSha,Date.now()-1000000);
await call(lateSha,null,lateBytes);state=await (await call(lateSha,{action:'start',text:lateText})).json();
for(const b of state.job.batches)await call(lateSha,{action:'batch',index:b.idx});
assert.equal((await (await call(lateSha,{action:'publish'})).json()).published,true);
const afterLate=await (await gateway.savedImport(new Request(origin+'/api/sap-import'),env)).json();
assert.equal(afterLate.text,beforeLateText.text,'late upload must preserve the exact current shared evidence');assert.doesNotMatch(afterLate.text,/كريمة\t7/);
// Large raw unified exports are processed as independently archived small
// unified files, never as a monolithic remote plan. Verify Python/TS parity.
const {desktopUnifiedChunks}=load('app/lib/sap-desktop-chunks.ts');
const large=[fields.join('\t'),urow({RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:'2026-11-18'}),
 urow({RecordType:'OPENING',DocumentDate:'2026-11-01',ItemCode:'DAR00005',ItemName:'كريمة',Unit:'Piece',Warehouse:'011',StockQuantity:5}),
 urow({RecordType:'CLOSING',DocumentDate:'2026-11-18',ItemCode:'DAR00005',ItemName:'كريمة',Unit:'Piece',Warehouse:'011',StockQuantity:1205}),
 ...Array.from({length:1200},(_,i)=>urow({RecordType:'TRANSFER',DocumentNumber:String(2620000+i),DocumentDate:'2026-11-18',LineNumber:1,ItemCode:'DAR00005',ItemName:'كريمة',Quantity:1,Unit:'Piece',FromWarehouse:'001',ToWarehouse:'011',Remarks:'السرو '+'م'.repeat(120),CancellationStatus:'N'}))].join('\n');
const chunks=desktopUnifiedChunks(large);assert.ok(chunks.length>1);
const py=execFileSync('python3',['-c',"import sys,json;sys.path.insert(0,'desktop-sync');from unified_chunks import unified_chunks;print(json.dumps(unified_chunks(sys.stdin.read()),ensure_ascii=False))"],{input:large,encoding:'utf8',maxBuffer:4*1024*1024});
assert.deepEqual(JSON.parse(py),chunks,'Windows and server must derive byte-identical chunks');
for(const chunk of chunks){assert.ok(Buffer.byteLength(chunk)<=280000);assert.ok(!chunk.includes('OPENING\t'));assert.ok(!chunk.includes('CLOSING\t'),'Partial stock snapshots must never enter child archives');}
const lb=new TextEncoder().encode(large),ls=createHash('sha256').update(lb).digest('hex');
const largeStored=await (await call(ls,null,lb)).json();assert.ok(largeStored.key.startsWith('lieutenant/unified__'));
const childHashes=[];
for(const [i,chunk] of chunks.entries()){
 const bytes=new TextEncoder().encode(chunk),sha=createHash('sha256').update(bytes).digest('hex');childHashes.push(sha);
 await call(sha,null,bytes,'part-'+i+'.txt');
 state=await (await call(sha,{action:'start',text:chunk})).json();
 for(const b of state.job.batches)await call(sha,{action:'batch',index:b.idx});
}
assert.equal((await (await call(ls)).json()).job,null,'large parent must not invoke monolithic planner');
assert.equal((await call(ls,{action:'publish',chunks:childHashes.slice(1)})).status,409,'missing chunk cannot publish original');
const completedLarge=await call(ls,{action:'publish',chunks:childHashes});assert.equal(completedLarge.status,200,await completedLarge.clone().text());
assert.equal((await completedLarge.json()).published,true);
// Revocation/expiration applies immediately to ingestion, never to old data.
await gateway.handleInstitution(new Request(origin+'/api/desktop-sync/devices?id='+paired.id,{method:'DELETE',headers:{Cookie:cookie,Origin:origin}}),env);
assert.equal((await call('')).status,401);
assert.ok(objects.has(stored.key));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sap_file_jobs').get().n,5+chunks.length);
globalThis.fetch=priorFetch;
console.log('PASS: real desktop gateway, scoped/revocable hashed credentials, full SHA verification, lost-upload recovery, planner HTTP 546 handling, preserved 1/3 batches, daily same-name imports, no duplicate documents/invoices/cancellations, merged shared view and fenced immutable publication.');
