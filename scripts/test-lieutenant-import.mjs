import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';

// Run the real route and its real SQL against SQLite, with only the D1 transport
// emulated. Invoice payloads and approvals are frozen throughout every retry.
const sqlite=new DatabaseSync(':memory:');
let failNextBatch=false;
const wrap=(sql,args=[])=>({
  bind(...values){return wrap(sql,values)},
  async all(){return {results:sqlite.prepare(sql).all(...args)}},
  async first(){return sqlite.prepare(sql).get(...args)||null},
  async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}}},
});
const DB={prepare:sql=>wrap(sql),async batch(queries){
  if(failNextBatch){failNextBatch=false;throw Error('simulated D1 outage')}
  sqlite.exec('BEGIN');
  try{const result=[];for(const query of queries)result.push(await query.run());sqlite.exec('COMMIT');return result}
  catch(error){sqlite.exec('ROLLBACK');throw error}
}};
const cache=new Map();
function load(file){
  file=resolve(file);if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env.VITE_APP_COMMIT',"'test-commit'");
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('exports','require','__ASQARYA_COMMIT__',compiled)(exports,name=>{
    if(name==='cloudflare:workers')return {env:{DB}};
    if(name.startsWith('.')&&!name.endsWith('.json'))return load(resolve(dirname(file),name+'.ts'));
    return createRequire(file)(name);
  },'test-commit');return exports;
}
const {POST,GET}=load('app/api/reconcile/route.ts');
const {lieutenantImportPlan}=load('app/lib/lieutenant-import-plan.ts');
const schema=JSON.parse(fs.readFileSync('app/lib/reconciliation-schema.json','utf8'));
for(const sql of schema)sqlite.exec(sql);
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const doc=(number,index)=>({number,date:'2026-11-14',paste:header+'\nDAR00005\tCream\t1\tPiece\t001\t011',branch:'1',remarks:'',reverse:false,cancellationState:'active',invoiceNumbers:[],issues:[],lineCount:1,...index});
const documents=Array.from({length:787},(_,i)=>doc(String(2616000+i)));
const legacy={transfers:[{number:'2616000 + 2616001',paste:header}],invoices:[{number:'2631000001',amount:'123.000',complete:true}],pages:{'i:11371486':'1'}};
sqlite.prepare('INSERT INTO reconciliations(id,transfer_no,revision_token,branch,driver,doc_date,status,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run('legacy','2616000 + 2616001','revision','1','','2026-11-01','match',JSON.stringify(legacy),'before','before');
sqlite.prepare('INSERT INTO transfer_keys(key,group_id) VALUES(?,?)').run('2616002','legacy');
const before=sqlite.prepare('SELECT * FROM reconciliations').all();
const request=transfers=>POST(new Request('https://example.test/api/reconcile',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.test'},body:JSON.stringify({action:'lieutenantImport',sourceFile:'lieutenant/transfers__'+'a'.repeat(32)+'__fixture.txt',transfers})}));
// A saved batch survives a later failure; retry starts with the full file.
assert.equal((await request(documents.slice(0,10))).status,200);
const persisted=sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n;
failNextBatch=true;
const failure=await request(documents.slice(10,20));
assert.equal(failure.status,500);assert.ok((await failure.json()).error);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n,persisted);
for(let pass=0;pass<3;pass++){
  const result=[];
  for(let offset=0;offset<documents.length;offset+=10){
    const response=await request(documents.slice(offset,offset+10));
    assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.added+data.existing,data.total);
    result.push(...data.documents);
  }
  assert.equal(result.length,787);assert.equal(new Set(result.map(row=>row.number)).size,787);
  if(pass>0)assert.ok(result.every(row=>row.state==='existing'));
  console.log('PASS: real import route, pass',pass+1,'classified',result.length,'without duplicates');
}
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n,784);
assert.deepEqual(sqlite.prepare('SELECT * FROM reconciliations').all(),before);
const bad=await request([doc('2619999',{paste:header+'\nDAR00005\tCream\tBAD\tPiece\t001\t011'})]);
assert.equal(bad.status,400);assert.match((await bad.json()).error,/2619999/);
const plan=lieutenantImportPlan([
  ...documents.map(transfer=>({...transfer,transfer})),
  {transfer:doc('2629999'),issues:['invalid SAP quantity'],remarks:'',reverse:false,branch:'',invoiceNumbers:[],lineCount:1,cancellationState:'unknown'},
], '2026-11-01','2026-11-14');
assert.equal(plan.length,788);assert.equal(plan.at(-1).state,'excluded');assert.match(plan.at(-1).reason,/invalid SAP quantity/);
const version=await GET(new Request('https://example.test/api/reconcile?version=1'));
assert.deepEqual(await version.json(),{commit:'test-commit',workerVersion:null});
console.log('PASS: resumable batch failure, invalid document number/reason, immutable invoices and source-version JSON.');
