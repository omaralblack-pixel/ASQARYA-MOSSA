import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';

const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('app/lib/reconciliation-schema.json','utf8')
 .trim().startsWith('[')?JSON.parse(fs.readFileSync('app/lib/reconciliation-schema.json','utf8')).join(';'): '');
sqlite.exec(`CREATE TABLE sap_file_jobs(key TEXT PRIMARY KEY,total INTEGER,updated TEXT DEFAULT '',version INTEGER,generation TEXT,kind TEXT,plan TEXT);
 CREATE TABLE sap_file_batches(file_key TEXT,idx INTEGER,state TEXT,payload TEXT);
 CREATE TABLE sap_job_history(key TEXT);
 CREATE TABLE sap_batch_history(file_key TEXT);
 INSERT INTO reconciliations VALUES('manual','2616732','corrected branch','','2026-11-17','{"manual":true}','review','','',2,'token');
 INSERT INTO lieutenant_queue VALUES('2616732','2026-11-17','{"remarks":"old","invoiceNumbers":[]}','old','');`);
const manualBefore=sqlite.prepare('SELECT * FROM reconciliations').all();
const root='lieutenant/unified__'+'a'.repeat(32)+'__daily.txt';
const child='lieutenant/transfers__'+'b'.repeat(32)+'__sap-'+'a'.repeat(32)+'-transfers-0001-of-0001.txt';
const old='lieutenant/unified__'+'c'.repeat(32)+'__old.txt';
let files=[{key:old,name:'old.txt',kind:'unified',created:'2026-11-17T00:00:00Z'},
 {key:root,name:'daily.txt',kind:'unified',created:'2026-11-19T00:00:00Z'},
 {key:child,name:child.split('__').at(-1),kind:'transfers',created:'2026-11-19T00:01:00Z'}];
const header='Document Number\tDocument Date\tBranch Name\tRemarks\tItem No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse\tCANCELED';
const text=header+'\n2616732\t2026-11-17\t6\t2622912088\tCHS00470\tCheese\t10\tPiece\t001\t011\tN';
function statement(sql,values=[]){return {
 sql,values,bind(...args){return statement(sql,args)},
 async run(){const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)}}},
 async first(){return sqlite.prepare(sql).get(...values)||null},
 async all(){return {results:sqlite.prepare(sql).all(...values)}},
};}
const env={DB:{prepare:statement,async batch(statements){
 sqlite.exec('BEGIN');
 try{const results=[];for(const stmt of statements){
   const prepared=sqlite.prepare(stmt.sql);
   results.push(stmt.sql.trim().startsWith('SELECT')?prepared.all(...stmt.values):prepared.run(...stmt.values));
 }sqlite.exec('COMMIT');return results;
 }catch(error){sqlite.exec('ROLLBACK');throw error;}
}},SUPABASE_URL:'https://example.supabase.co',SUPABASE_STORAGE_SECRET:'test-only'};
const cache=new Map();
function load(file){
 file=resolve(file);if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 new Function('exports','require',js)(exports,name=>{
  if(name==='./institution')return {lieutenantFiles:async request=>new URL(request.url).searchParams.has('key')?
   new Response(text):Response.json({files,nextPage:null})};
  if(name.endsWith('.json'))return JSON.parse(fs.readFileSync(resolve(dirname(file),name),'utf8'));
  return name.startsWith('.')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name);
 });return exports;
}
const {replaceSapSnapshot}=load('worker/sap-snapshot.ts');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 assert.equal(options.method,'DELETE');
 const keys=JSON.parse(options.body).prefixes;
 files=files.filter(file=>!keys.includes(file.key));
 return Response.json(keys.map(name=>({name})));
};
const request=body=>new Request('https://example.com/api/sap-snapshot',{
 method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify(body)});
try{
 assert.equal((await replaceSapSnapshot(request({key:root,children:[child],documents:1}),env)).status,409);
 assert.equal(sqlite.prepare('SELECT payload FROM lieutenant_queue').get().payload,'{"remarks":"old","invoiceNumbers":[]}');
 assert.equal((await replaceSapSnapshot(request({action:'stage',key:root,child}),env)).status,200);
 sqlite.prepare('INSERT INTO sap_file_jobs(key,total) VALUES(?,1)').run(child);
 sqlite.prepare('INSERT INTO sap_file_batches VALUES(?,0,?,?)').run(child,'complete','{}');
 assert.equal((await replaceSapSnapshot(request({key:root,children:[child],documents:2}),env)).status,409);
 const committed=await replaceSapSnapshot(request({key:root,children:[child],documents:1}),env);
 assert.equal(committed.status,200,await committed.clone().text());
 const saved=sqlite.prepare('SELECT * FROM lieutenant_queue').get();
 const payload=JSON.parse(saved.payload);
 assert.equal(saved.transfer_no,'2616732');
 assert.deepEqual(payload.invoiceNumbers,['2622912088']);
 assert.equal(payload.transfer.number,'2616732');
 assert.deepEqual(sqlite.prepare('SELECT * FROM reconciliations').all(),manualBefore);
 assert.deepEqual(files.map(file=>file.key),[old,root,child],'Activation retains every immutable original and derived part');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sap_snapshot_history_rows').get().count,1);
 assert.equal(sqlite.prepare('SELECT payload FROM sap_snapshot_history_rows').get().payload,'{"remarks":"old","invoiceNumbers":[]}');
 assert.equal((await committed.clone().json()).deleted,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM lieutenant_queue').get().count,1);
 const get=path=>new Request('https://example.com/api/sap-snapshot'+path);
 const current=await (await replaceSapSnapshot(get('?rows=1'),env)).json();
 assert.equal(current.snapshot.documents,1);assert.equal(current.rows.length,1);assert.equal(current.hasMore,false);
 assert.equal(current.rows[0].transfer_no,'2616732');
 assert.equal((await replaceSapSnapshot(get('?rows=1&key=wrong'),env)).status,409);
 const {readActiveSap}=load('app/lib/active-sap.ts');
 globalThis.fetch=async url=>replaceSapSnapshot(new Request('https://example.com'+url),env);
 const active=await readActiveSap(new AbortController().signal);assert.equal(active.transfers.length,1);
 // Mock an internally inconsistent count: even a successful HTTP response is insufficient.
 globalThis.fetch=async()=>Response.json({...current,snapshot:{...current.snapshot,documents:2,activeCount:2}});
 await assert.rejects(readActiveSap(new AbortController().signal),/جميع ترحيلات/);
 globalThis.fetch=async()=>Response.json({...current,hasMore:true,next:null});
 await assert.rejects(readActiveSap(new AbortController().signal),/تسلسل/);
 globalThis.fetch=async()=>Response.json({...current,hasMore:true,next:'2616732'});
 await assert.rejects(readActiveSap(new AbortController().signal),/تسلسل/);
 // Corrupt one frozen row without changing its count. No match may be reported.
 globalThis.fetch=async()=>Response.json({...current,rows:[{transfer_no:'2616732',payload:'{bad'}]});
 await assert.rejects(readActiveSap(new AbortController().signal),/غير مقروءة/);
 globalThis.fetch=async()=>Response.json({...current,rows:[{transfer_no:'2616732',payload:JSON.stringify({...payload,transfer:{...payload.transfer,number:'wrong'}})}]});
 await assert.rejects(readActiveSap(new AbortController().signal),/غير مكتملة/);


 // The original archive and its existing snapshot rows are authoritative.
 // Identical *bytes*, not document numbers, permit safe stage reuse.
 const oldDigest=createHash('sha256').update(text).digest('hex').slice(0,32);
 const originalChunk='lieutenant/transfers__'+oldDigest+'__sap-'+'a'.repeat(32)+'-transfers-0001-of-0001.txt';
 sqlite.prepare('UPDATE sap_snapshot_rows SET child_key=? WHERE root_key=?').run(originalChunk,root);
 const nextRoot='lieutenant/unified__'+'d'.repeat(32)+'__next.txt';
 const nextChild='lieutenant/transfers__'+oldDigest+'__sap-'+'d'.repeat(32)+'-transfers-0001-of-0001.txt';
 files.push({key:nextRoot,name:'next.txt',kind:'unified',created:'2026-11-20T00:00:00Z'});
 files.push({key:nextChild,name:nextChild.split('__').at(-1),kind:'transfers',created:'2026-11-20T00:00:01Z'});
 const reuseRequest=request({action:'reuse',key:nextRoot,child:nextChild});
 const reuse=await replaceSapSnapshot(reuseRequest,env);
 assert.equal(reuse.status,200,await reuse.clone().text());
 assert.deepEqual(await reuse.json(),{reused:true,staged:1});
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sap_snapshot_rows WHERE root_key=?').get(nextRoot).count,1);
 assert.equal(sqlite.prepare('SELECT total FROM sap_file_jobs WHERE key=?').get(nextChild).total,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM lieutenant_queue').get().count,1,
  'Copying unchanged rows must not touch the live approved snapshot');
 assert.deepEqual(sqlite.prepare('SELECT * FROM reconciliations').all(),manualBefore);
 const replay=await (await replaceSapSnapshot(request({action:'reuse',key:nextRoot,child:nextChild}),env)).json();
 assert.equal(replay.reused,true,'Interrupted response can be replayed without duplicate writes');
 assert.equal(replay.alreadyStaged,true);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sap_snapshot_rows WHERE root_key=?').get(nextRoot).count,1);
 const fakeChild='lieutenant/transfers__'+'f'.repeat(32)+'__sap-'+'e'.repeat(32)+'-transfers-0001-of-0001.txt';
 const tampered=await replaceSapSnapshot(request({action:'reuse',
  key:'lieutenant/unified__'+'e'.repeat(32)+'__fake.txt',child:fakeChild}),env);
 assert.equal(tampered.status,409,'Unverified archive hash must never be reused');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sap_file_jobs WHERE key=?').get(fakeChild).count,0);
 const committedReuse=await replaceSapSnapshot(request({key:nextRoot,children:[nextChild],documents:1}),env);
 assert.equal(committedReuse.status,200,await committedReuse.clone().text());
 assert.equal(sqlite.prepare('SELECT source_file FROM lieutenant_queue').get().source_file,nextRoot);
 assert.deepEqual(sqlite.prepare('SELECT * FROM reconciliations').all(),manualBefore);

 console.log('PASS: atomic daily SAP replacement, exact invoice/transfer recovery, incomplete snapshot protection, rollback queue, verified incremental reuse and all originals retained, manual corrections preserved.');
}finally{globalThis.fetch=originalFetch;sqlite.close();}
