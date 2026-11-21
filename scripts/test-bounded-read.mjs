import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const sqlite=new DatabaseSync(':memory:');
const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values)},async all(){return {results:sqlite.prepare(sql).all(...args)}},async first(){return sqlite.prepare(sql).get(...args)||null},async run(){return sqlite.prepare(sql).run(...args)}});
const cache=new Map();
function load(file){file=resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('exports','require',js)(exports,name=>name==='cloudflare:workers'?{env:{DB:{prepare:wrap,async batch(queries){return Promise.all(queries.map(q=>q.run()))}}}}:name.startsWith('.')&&!name.endsWith('.json')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name));return exports;
}
const {boundedRead,readJson,mapBounded,readAllRecords}=load('app/lib/bounded-read.ts');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS: '+name)}
const originalFetch=globalThis.fetch;
try{
 await test('Hanging transport settles on timeout and aborts the request',async()=>{
  let signal;globalThis.fetch=async(_,init)=>{signal=init.signal;return new Promise(()=>{})};
  await assert.rejects(boundedRead('/hang',r=>r.json(),{timeoutMs:15}),/مهلة/);assert.equal(signal.aborted,true);
 });
 await test('A hanging response body is also bounded',async()=>{
  globalThis.fetch=async()=>new Response(new ReadableStream({start(){}}));
  await assert.rejects(boundedRead('/body',r=>r.text(),{timeoutMs:15}),/مهلة/);
 });
 await test('Superseded and already aborted reads cannot apply stale results',async()=>{
  const controller=new AbortController();let calls=0;
  globalThis.fetch=async()=>{calls++;return new Promise(()=>{})};
  const old=boundedRead('/old',r=>r.text(),{signal:controller.signal});controller.abort(Error('superseded'));
  await assert.rejects(old,/superseded/);await assert.rejects(boundedRead('/old',r=>r.text(),{signal:controller.signal}),/superseded/);assert.equal(calls,1);
 });
 await test('503 HTML, truncated JSON and session expiry have readable Arabic errors',async()=>{
  for(const [response,pattern] of [[new Response('error code: 1102',{status:503}),/HTTP 503/],[new Response('{"broken":',{headers:{'content-type':'application/json'}}),/غير مكتملة/],[new Response('',{status:401}),/جلسة/]]){
   globalThis.fetch=async()=>response;await assert.rejects(readJson('/error'),pattern);
  }
 });
 await test('Bounded workers preserve every input and propagate a failed source',async()=>{
  let active=0,max=0;const out=await mapBounded([1,2,3,4,5],2,async n=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,2));active--;return n*2});
  assert.deepEqual(out,[2,4,6,8,10]);assert.equal(max,2);
  await assert.rejects(mapBounded([1,2,3],2,async n=>{if(n===2)throw Error('missing source');return n}),/missing source/);
 });
 await test('All invoice pages are read, and broken/repeated cursors or missing pages fail closed',async()=>{
  const first={records:[{id:'a',payload:'{}'}],hasMore:true,nextCursor:{updated:'2',id:'a'}};
  assert.equal((await readAllRecords(async cursor=>cursor?{records:[{id:'b',payload:'{}'}],hasMore:false,nextCursor:null}:first)).length,2);
  await assert.rejects(readAllRecords(async cursor=>{if(cursor)throw Error('lost page');return first}),/lost page/);
  await assert.rejects(readAllRecords(async()=>first),/تكرار/);
  await assert.rejects(readAllRecords(async()=>({...first,nextCursor:null})),/تسلسل/);
 });
 await test('Real SQLite paginated API preserves frozen quantities and references across 37 records',async()=>{
  const route=load('app/api/reconcile/route.ts');
  // Let the route initialize its existing schema, then insert isolated fixtures.
  await route.GET(new Request('https://example.test/api/reconcile'));
  const frozen={invoices:[{id:'i',number:'2621610051',date:'2026-11-01',complete:true,quantities:{'11371486':'12'},auditLines:'11371486\t12',sapInstitutionChoices:{DAR00005:'11371486'}}],transfers:[],referenceSnapshot:[{code:'11371486',cartonPieces:20,price:526.320}],branchException:'saved decision'};
  for(let i=0;i<37;i++)sqlite.prepare('INSERT INTO reconciliations(id,transfer_no,branch,driver,doc_date,payload,status,created,updated,revision_token) VALUES(?,?,?,?,?,?,?,?,?,?)').run('r'+String(i).padStart(3,'0'),'t'+i,'23','','2026-11-01',JSON.stringify(frozen),'match','','2026-11-21','token');
  const records=await readAllRecords(async cursor=>{
   const params=new URLSearchParams({reassuranceRecords:'1'});if(cursor){params.set('afterId',cursor.id);params.set('afterUpdated',cursor.updated)}
   const response=await route.GET(new Request('https://example.test/api/reconcile?'+params));assert.equal(response.status,200);const page=await response.json();assert.ok(page.records.length<=10);return page;
  });
  assert.equal(records.length,37);assert.equal(new Set(records.map(r=>r.id)).size,37);
  for(const record of records)assert.deepEqual(JSON.parse(record.payload),frozen);
  const meta=await (await route.GET(new Request('https://example.test/api/reconcile?reassuranceMeta=1&from=2026-11-01'))).json();assert.ok(Array.isArray(meta.reference));assert.ok(Array.isArray(meta.openingStock));
 });
 await test('Failure of an older SAP source remains a visible completeness issue',async()=>{
  const {restoreLieutenantSource}=load('app/lib/lieutenant-source.ts');
  const text='Document Number\tDocument Date\tBranch Code\tBranch Name\tRemarks\tItem No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse\n2616675\t2026-11-01\t23\tbranch\t\tDAR00005\titem\t1\tPiece\t001\t011';
  const source=await restoreLieutenantSource([{key:'new',name:'new',kind:'transfers',created:'2'},{key:'old',name:'old',kind:'transfers',created:'1'}],['23 — branch'],async file=>{if(file.key==='old')throw Error('missing historical page');return text},async()=>undefined);
  assert.ok(source.scan.issues.some(s=>s.includes('missing historical page')));
 });
}finally{globalThis.fetch=originalFetch;sqlite.close()}
console.log(`${passed} bounded-read regression tests passed.`);
