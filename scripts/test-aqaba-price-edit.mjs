import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';
import ts from 'typescript';

// Exercise the real save endpoint, settings compare-and-swap and price reader.
const sql=new DatabaseSync(':memory:');let beforeReferenceWrite;
const env={DB:{prepare(query){
 const bound=(...values)=>({bind:bound,
  async first(){return sql.prepare(query).get(...values)??null},
  async all(){return {results:sql.prepare(query).all(...values)}},
  async run(){if(beforeReferenceWrite&&query.startsWith('UPDATE settings SET value=')){const run=beforeReferenceWrite;beforeReferenceWrite=undefined;run()}
   return {meta:sql.prepare(query).run(...values)}}});return bound();
 },async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}
}};
const cache=new Map();
function load(file){file=resolve(file);if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('exports','require',js)(exports,name=>name==='cloudflare:workers'?{env}:name.endsWith('.json')||!name.startsWith('.')?createRequire(file)(name):load(resolve(dirname(file),name+'.ts')));
 return exports;
}
const {GET,POST}=load('app/api/reconcile/route.ts');
const {prepareReconciliation}=load('app/lib/reconcile.ts');
const {aqabaMatchReference}=load('app/lib/aqaba-instant-reference.ts');
const url='https://example.test/api/reconcile';
const get=async query=>{const response=await GET(new Request(url+query));assert.equal(response.status,200);return response.json()};
const post=body=>POST(new Request(url,{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:JSON.stringify(body)}));
await get('?aqabaPricing=1');
const item={code:'11373686',sapCode:'CHS00561',name:'جبنة',price:1650,active:true,sapUnit:'Piece',cartonPieces:12,kgPerPiece:null,invoicePack:null};
sql.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('reconciliationReference',JSON.stringify([item]));
const read=()=>JSON.parse(sql.prepare('SELECT value FROM settings WHERE key=?').get('reconciliationReference').value);
const price=(sapCode,value,previous=null)=>({aqabaPrice:value,aqabaSapCode:sapCode,aqabaPricePrevious:previous});
let response=await post({action:'saveReferenceItem',item,previous:item,...price('CHS00561','١٫٢٣٤')});
assert.equal(response.status,200,await response.clone().text());
let owner=read()[0];assert.equal(owner.price,1650);assert.equal(owner.aqabaPrices.CHS00561.price,1234);
assert.equal((await get('?aqabaPricing=1')).reference.find(row=>row.sapCode==='CHS00561').price,1234);
assert.equal(aqabaMatchReference(read(),[]).find(row=>row.sapCode==='CHS00561').price,1234,'Manual price overrides bundled defaults');
const blue={key:'new-blue',invoice:'2650710999',date:'2026-11-30',item:'CHS00561',description:'new import',price:9.999};
assert.equal(aqabaMatchReference(read(),[blue]).find(row=>row.sapCode==='CHS00561').price,1234,'Reimport cannot erase an explicit operator price');

const alias={...item,sapCode:'CFC99999',sapUnit:'Carton',cartonPieces:24};
response=await post({action:'linkReference',item:alias,...price('CFC99999','0.790')});
assert.equal(response.status,200,await response.clone().text());owner=read()[0];
assert.equal(owner.price,1650);assert.equal(owner.aqabaPrices.CHS00561.price,1234);
assert.equal(owner.sapAliases.length,1);assert.equal(owner.aqabaPrices.CFC99999.price,790);
const draft={mode:'manual',branch:'84 — العقبة',driver:'',date:'2026-11-16',notes:'',checks:{},invoices:[],transfers:[{
 id:'t',number:'2619999',date:'2026-11-16',paste:'Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse\nCFC99999\tTest\t2\tCarton\t001\t011'}]};
const result=prepareReconciliation(draft,(await get('?aqabaPricing=1')).reference).result;
assert.equal(result.rows[0].transfer,48);assert.equal(result.rows[0].unitPrice,790);assert.equal(result.expected,37920);
response=await post({action:'linkReference',item:alias,...price('CFC99999','0.800',owner.aqabaPrices.CFC99999)});
assert.equal(response.status,200);assert.equal(read()[0].sapAliases.length,1,'Saving an already linked price must not duplicate the alias');

let before=JSON.stringify(read());
response=await post({action:'linkReference',item:alias,...price('CFC99999','0.900')});
assert.equal(response.status,409);assert.equal(JSON.stringify(read()),before,'A stale price editor cannot overwrite another saved price');
for(const invalid of ['-1','0.1234','abc','100000.001']){
 owner=read()[0];response=await post({action:'saveReferenceItem',item:owner,previous:owner,...price('CHS00561',invalid,owner.aqabaPrices.CHS00561)});
 assert.equal(response.status,400,invalid);assert.equal(JSON.stringify(read()),before);
}
response=await post({action:'linkReference',item:{...alias,sapCode:'CFC99998',cartonPieces:0},...price('CFC99998','1.000')});
assert.equal(response.status,400);assert.equal(JSON.stringify(read()),before,'Invalid mapping must save neither its link nor its price');
owner=read()[0];response=await post({action:'saveReferenceItem',item:owner,previous:owner,...price('MET99999','1.000')});
assert.equal(response.status,400);assert.equal(JSON.stringify(read()),before,'A price cannot be attached to another SAP code');

beforeReferenceWrite=()=>{const concurrent=read();concurrent[0].name='Concurrent reference update';sql.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(concurrent),'reconciliationReference')};
response=await post({action:'linkReference',item:{...alias,sapCode:'CFC99997'},...price('CFC99997','1.000')});
assert.equal(response.status,409);owner=read()[0];
assert.equal(owner.name,'Concurrent reference update');assert.ok(!owner.sapAliases.some(x=>x.sapCode==='CFC99997'));assert.ok(!owner.aqabaPrices.CFC99997);
response=await post({action:'saveReferenceItem',item:owner,previous:owner,...price('CHS00561','0.000',owner.aqabaPrices.CHS00561)});
assert.equal(response.status,200);assert.equal((await get('?aqabaPricing=1')).reference.find(row=>row.sapCode==='CHS00561').price,0);
assert.equal(read()[0].price,1650);
const brandNew={...item,code:'11889977',sapCode:'MET99997',name:'صنف جديد',price:null};
response=await post({action:'linkReference',item:brandNew,...price('MET99997','0.560')});
assert.equal(response.status,200);assert.equal(read().find(x=>x.code===brandNew.code).price,null);
assert.equal((await get('?aqabaPricing=1')).reference.find(x=>x.sapCode==='MET99997').price,560,'A newly defined and linked item immediately has its Aqaba price');
assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM aqaba_blue').get().n,0,'Editing prices must not create fictional blue invoices');
assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reconciliations').get().n,0);
console.log('PASS: direct Aqaba price edits, atomic link and price, alias prices, recalculated totals, three decimals, stale editors, concurrent writes, zero price and unchanged Amman/invoices.');
