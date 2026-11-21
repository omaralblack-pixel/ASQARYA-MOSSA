import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
function fresh(){
 const cache=new Map();
 function load(file){file=resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('exports','require',js)(exports,name=>name.startsWith('.')&&!name.endsWith('.json')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name));return exports;
 }
 return {read:load('app/lib/approved-sap-client.ts').readCurrentSapImport,load};
}
const header='Document Number\tDocument Date\tBranch Code\tBranch Name\tRemarks\tJournal Remarks\tU_ST_Remarks\tItem No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse\tCANCELED';
const text=header+'\n2617001\t2026-11-19\t77\tرحاب\t\t2623908380\tملاحظات أصلية\tDAR00005\titem\t12\tPiece\t001\t011\tN\n2617002\t2026-11-19\t77\tرحاب\tعكسي ترحيل 2617001\t\t\tDAR00005\titem\t12\tPiece\t011\t001\tN';
const key=(body,kind='transfers',name='current.txt')=>'lieutenant/'+kind+'__'+createHash('sha256').update(body).digest('hex').slice(0,32)+'__'+name;
const source=body=>({key:key(body),created:'2026-11-19',committed:'2026-11-19T11:29:59Z',documents:2,activeCount:2});
const originalFetch=globalThis.fetch;let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS: '+name)}
try{
 await test('Approved D1 original wins over a stale shared import and preserves all note fields',async()=>{
  const {read,load}=fresh();let originals=0,legacy=0;
  globalThis.fetch=async url=>{
   if(url==='/api/sap-snapshot')return Response.json({snapshot:source(text)});
   if(String(url).startsWith('/api/lieutenant-files?key=')){originals++;assert.equal(new URL(url,'https://fixture.test').searchParams.get('key'),key(text));return new Response(text)}
   legacy++;throw Error('Legacy or unapproved source must not be requested');
  };
  const result=await read();assert.equal(result.text,text);assert.equal(result.documents,2);assert.equal(result.key,key(text));
  assert.equal((await read()).text,text);assert.equal(originals,1,'Immutable verified originals are cached');assert.equal(legacy,0);
  const scan=load('app/lib/lieutenant.ts').parseLieutenantTransfers(result.text,[]);
  assert.deepEqual(scan.transfers[0].invoiceNumbers,['2623908380']);assert.match(scan.transfers[0].remarks,/ملاحظات أصلية/);assert.equal(scan.transfers[1].reverse,true);
 });
 await test('Unified-only archives load the approved transfer section without a separate transfers file',async()=>{
  const {read,load}=fresh();const {unifiedSapQuery}=load('app/lib/unified-sap-query.ts');
  const columns=[...unifiedSapQuery('2026-11-01','2026-11-19').split('\nUNION ALL\n')[0].matchAll(/ AS "([^"]+)"/g)].map(m=>m[1]);
  const row=values=>columns.map(c=>String(values[c]??'')).join('\t');
  const unified=[columns.join('\t'),row({RecordType:'WINDOW',DocumentDate:'2026-11-01',BaseRef:'2026-11-19'}),
   ...[1,2].map(n=>row({RecordType:'TRANSFER',DocumentNumber:String(2617000+n),DocumentDate:'2026-11-19',ItemCode:'DAR00005',ItemName:'item',Quantity:'12',Unit:'Piece',FromWarehouse:'001',ToWarehouse:'011',CancellationStatus:'N',JournalRemarks:'2623908380',BranchName:'77'}))].join('\n');
  const snapshot={...source(unified),key:key(unified,'unified')};
  globalThis.fetch=async url=>url==='/api/sap-snapshot'?Response.json({snapshot}):new Response(unified);
  const result=await read();assert.equal(result.key,snapshot.key);assert.ok(result.text.includes('2623908380'));assert.equal(load('app/lib/lieutenant.ts').parseLieutenantTransfers(result.text,[]).transfers.length,2);
 });
 await test('Missing approval, count mismatch and a corrupt pointer cannot silently use a legacy file',async()=>{
  for(const snapshot of [null,{...source(text),activeCount:1},{...source(text),key:'untrusted/current.json'},{...source(text),committed:''}]){
   const {read}=fresh();let calls=0;globalThis.fetch=async url=>{calls++;assert.equal(url,'/api/sap-snapshot');return Response.json({snapshot})};
   await assert.rejects(read(),/D1/);assert.equal(calls,1);
  }
 });
 await test('A 503 from D1 is a visible failure, never evidence to fall back to current.json',async()=>{
  const {read}=fresh();let calls=0;globalThis.fetch=async url=>{calls++;assert.equal(url,'/api/sap-snapshot');return new Response('error code: 1102',{status:503})};
  await assert.rejects(read(),/HTTP 503/);assert.equal(calls,1);
 });
 await test('Original bytes must match the active SHA-256 fingerprint',async()=>{
  const {read}=fresh();globalThis.fetch=async url=>url==='/api/sap-snapshot'?Response.json({snapshot:source(text)}):new Response(text+'changed');
  await assert.rejects(read(),/بصمة/);
 });
 await test('The original must contain exactly the approved number of documents',async()=>{
  const {read}=fresh();globalThis.fetch=async url=>url==='/api/sap-snapshot'?Response.json({snapshot:{...source(text),documents:3,activeCount:3}}):new Response(text);
  await assert.rejects(read(),/جميع ترحيلات/);
 });
 await test('An activation racing with a download invalidates the read',async()=>{
  const {read}=fresh();let probes=0;globalThis.fetch=async url=>url==='/api/sap-snapshot'?Response.json({snapshot:++probes===1?source(text):{...source(text),committed:'2026-11-21'}}):new Response(text);
  await assert.rejects(read(),/تغيّرت نسخة/);
 });
 await test('An interrupted source read is abortable even when the transport hangs',async()=>{
  const {read}=fresh();const controller=new AbortController();globalThis.fetch=async()=>new Promise(()=>{});
  const pending=read({signal:controller.signal});controller.abort(Error('superseded'));
  await assert.rejects(pending,/superseded/);
 });
 await test('Failed archive reads are evicted so retry can recover',async()=>{
  const {read}=fresh();let originals=0;globalThis.fetch=async url=>url==='/api/sap-snapshot'?Response.json({snapshot:source(text)}):++originals===1?new Response('',{status:503}):new Response(text);
  await assert.rejects(read(),/HTTP 503/);assert.equal((await read()).text,text);assert.equal(originals,2);
 });
}finally{globalThis.fetch=originalFetch}
console.log(`${passed} approved SAP source regressions passed.`);
