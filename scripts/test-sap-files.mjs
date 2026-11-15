import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
const sqlite=new DatabaseSync(':memory:');
let failImport=false,scans=0,writes=0,originalChecks=0;
const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values)},async all(){if(failImport&&sql.startsWith('INSERT OR IGNORE INTO lieutenant_queue')){failImport=false;throw Error('injected failure')}if(sql.startsWith('INSERT OR IGNORE INTO lieutenant_queue'))writes++;if(sql.includes("FROM reconciliations r,"))scans++;return {results:sqlite.prepare(sql).all(...args)}},async first(){return sqlite.prepare(sql).get(...args)||null},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}}}});
const DB={prepare:sql=>wrap(sql),async batch(queries){
 if(failImport&&queries.some(q=>q._import)){failImport=false;throw Error('injected failure');}
 sqlite.exec('BEGIN');try{const out=[];for(const q of queries)out.push(await q.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}
}};
const cache=new Map();
function load(file,override){file=resolve(file);const cacheKey=file+(override?'#baseline':'');if(cache.has(cacheKey))return cache.get(cacheKey);const exports={};cache.set(cacheKey,exports);
 const source=override||fs.readFileSync(file,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('exports','require','__ASQARYA_COMMIT__',js)(exports,name=>{
  if(name==='cloudflare:workers')return {env:{DB}};
  if(name==='../../../worker/institution')return {lieutenantFiles:async()=>{originalChecks++;return new Response('original bytes');}};
  if(name.startsWith('.')&&!name.endsWith('.json'))return load(resolve(dirname(file),name+'.ts'));
  return createRequire(file)(name);
 },'test');return exports;
}
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{assert.ok(String(url).includes('/api/lieutenant-files?key='));originalChecks++;return new Response('original bytes');};
const route=load('app/api/sap-processing/route.ts');
const reconcile=load('app/api/reconcile/route.ts');
const {buildSapPlan,classifySapFile}=load('app/lib/sap-processing.ts');
const header=['Document Number','Document Date','Branch Code','Branch Name','Remarks','Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'].join('\t');
const text=[header,...Array.from({length:867},(_,i)=>[String(2617000+i),'2026-11-14','21','السرو','','DAR00005','كريمة',1,'Piece','001','011'].join('\t'))].join('\n');
const plan=buildSapPlan(text,JSON.parse(fs.readFileSync('app/branches.json','utf8')));
assert.equal(plan.count,867);assert.equal(plan.kind,'transfers');assert.equal(plan.batches.length,18);assert.equal(plan.documents.filter(x=>x.state==='pending').length,867);
const key='lieutenant/transfers__'+'a'.repeat(32)+'__fixture.txt';
const req=body=>new Request('https://example.test/api/sap-processing',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.test'},body:JSON.stringify(body)});
async function call(body){const res=await route.POST(req(body));assert.equal(res.status,200,await res.clone().text());return (await res.json()).job;}
async function read(file=key){return (await (await route.GET(new Request('https://example.test/api/sap-processing?key='+encodeURIComponent(file)))).json()).job;}
let job=await call({action:'start',key,text});assert.equal(job.total,18);assert.equal(job.status,'pending');assert.equal(job.done,0);
const schema=JSON.parse(fs.readFileSync('app/lib/reconciliation-schema.json','utf8'));for(const sql of schema)sqlite.exec(sql);
const invoice={transfers:[{number:'2999999'}],invoices:[{number:'2631000001',complete:true,amount:'123.000'}],notes:'keep'};
sqlite.prepare('INSERT INTO reconciliations(id,transfer_no,revision_token,branch,driver,doc_date,status,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').run('saved','2999999','revision','21','','2026-11-01','match',JSON.stringify(invoice),'old','old');
sqlite.prepare("INSERT INTO lieutenant_cancellation_decisions(transfer_no,decision,related_type,related_number,note,revision,updated_at) VALUES('2999998','ignore','','','keep decision',1,'old')").run();
const before=sqlite.prepare('SELECT * FROM reconciliations').all();
job=await call({action:'batch',key,index:0});assert.equal(job.done,1);assert.equal(job.documents.filter(x=>x.state==='added').length,50);
const snapshot=sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n;
failImport=true;job=await call({action:'batch',key,index:1});assert.equal(job.failed,1);assert.equal(job.done,1);assert.equal(job.status,'failed');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n,snapshot);
job=await read();assert.equal(job.done,1);assert.equal(job.failed,1);assert.ok(job.batches[1].error);
const checksBefore=originalChecks;job=await call({action:'start',key,text});assert.equal(job.done,1);assert.equal(originalChecks,checksBefore,'same file never reparses or redownloads source');
for(const b of job.batches.filter(x=>x.state!=='complete'))job=await call({action:'batch',key,index:b.idx});
assert.equal(job.done,18);assert.equal(job.status,'complete');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n,867);
const scansBefore=scans,writesBefore=writes;job=await call({action:'batch',key,index:0});assert.equal(scans,scansBefore);assert.equal(writes,writesBefore);assert.equal(job.done,18);
const second='lieutenant/transfers__'+'b'.repeat(32)+'__renamed.txt';job=await call({action:'start',key:second,text});assert.equal(job.total,0);assert.equal(job.status,'complete');assert.equal(job.documents.filter(x=>x.state==='existing').length,867);
const changed='lieutenant/transfers__'+'c'.repeat(32)+'__changed.txt';job=await call({action:'start',key:changed,text:text.replace('كريمة\t1','كريمة\t2')});assert.equal(job.total,1);assert.equal(job.documents.filter(x=>x.state==='pending').length,1);
job=await call({action:'batch',key:changed,index:0});assert.equal(job.status,'complete');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lieutenant_queue').get().n,867);
// A deleted queue record must not be concealed by an old receipt in a new export.
sqlite.prepare('DELETE FROM lieutenant_queue WHERE transfer_no=?').run('2617001');
const repaired='lieutenant/transfers__'+'d'.repeat(32)+'__repair.txt';job=await call({action:'start',key:repaired,text});assert.ok(job.documents.some(x=>x.number==='2617001'&&x.state==='pending'));
// Atomic leases: a second tab cannot claim an active batch; expired work resumes.
sqlite.prepare("UPDATE sap_file_batches SET state='running',lease=?,token='other' WHERE file_key=? AND idx=0").run(Date.now()+10000,repaired);
const activeRecheck=await route.POST(req({action:'start',key:repaired,text,recheck:true}));assert.equal(activeRecheck.status,409,'active processing cannot be reset by another tab');
let result=await route.POST(req({action:'batch',key:repaired,index:0}));assert.equal((await result.json()).busy,true);
sqlite.prepare('UPDATE sap_file_batches SET lease=0 WHERE file_key=?').run(repaired);job=await call({action:'batch',key:repaired,index:0});assert.equal(job.status,'complete');
job=await call({action:'start',key,text,recheck:true});assert.equal(job.status,'complete');assert.equal(job.total,0);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sap_job_history WHERE key=?').get(key).n,1);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sap_batch_history WHERE file_key=?').get(key).n,18);
assert.deepEqual(sqlite.prepare('SELECT * FROM reconciliations').all(),before);assert.equal(sqlite.prepare('SELECT note FROM lieutenant_cancellation_decisions').get().note,'keep decision');
const balance='رقم الصنف\tاسم الصنف\tالمستودع\tوحدة المخزون\tالرصيد الفعلي بنهاية التاريخ\nDAR00005\tكريمة\t011\tPiece\t5';
assert.equal(classifySapFile(balance),'balance');assert.equal(classifySapFile(balance.replace('الرصيد الفعلي بنهاية التاريخ','الرصيد الافتتاحي')),'opening');
for(const kind of ['balance','opening']){const k='lieutenant/'+kind+'__'+'e'.repeat(32)+'__2026-11-14__stock.txt';const stock=await call({action:'start',key:k,text:kind==='balance'?balance:balance.replace('الرصيد الفعلي بنهاية التاريخ','الرصيد الافتتاحي')});assert.equal(stock.total,0);assert.equal(stock.kind,kind);assert.equal(stock.count,1);}
const officialHeader=['نوع المستند','رقم الفاتورة','DocEntry','التاريخ','رقم الزبون','رقم السطر','المستودع','كود الصنف','اسم الصنف','الوحدة','الكمية','سعر الوحدة','القيمة قبل الضريبة','الضريبة','حالة الإلغاء'].join('\t');
const official=officialHeader+'\n'+['IN','260063818','260063818','2026-11-03','C0006751',1,'011','CHS00561','جبنة','Piece',600,0.313,187.8,0,'N'].join('\t');
const officialKey='lieutenant/other__'+'f'.repeat(32)+'__official.txt';job=await call({action:'start',key:officialKey,text:official});assert.equal(job.kind,'official');job=await call({action:'batch',key:officialKey,index:0});assert.equal(job.status,'complete');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM aqaba_official').get().n,1);
const oinm='معرف حركة المخزون\tالتاريخ\tنوع حركة SAP\tDocEntry\tرقم المستند\tرقم السطر\tكود الصنف\tاسم الصنف\tالمستودع\tالوارد\tالصادر\tرقم الزبون\n12345\t2026-11-03\t67\t89101\t2615754\t0\tCHS00561\tجبنة\t011\t600\t0\t';
const oinmKey='lieutenant/other__'+'9'.repeat(32)+'__oinm.txt';job=await call({action:'start',key:oinmKey,text:oinm});assert.equal(job.kind,'inventory');job=await call({action:'batch',key:oinmKey,index:0});assert.equal(job.status,'complete');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM aqaba_oinm').get().n,1);
const transferHeader='رقم الترحيل\tDocEntry\tالتاريخ\tRemarks\tحالة الإلغاء\tرقم السطر\tكود الصنف\tاسم الصنف\tالوحدة\tالكمية\tمن المستودع\tإلى المستودع';
const aqabaTransfer=transferHeader+'\n2615754\t89101\t2026-11-03\tمؤسسة العقبة\tN\t1\tCHS00561\tجبنة\tPiece\t600\t001\t011';
const aqabaKey='lieutenant/transfers__'+'8'.repeat(32)+'__aqaba.txt';job=await call({action:'start',key:aqabaKey,text:aqabaTransfer});for(const b of job.batches)job=await call({action:'batch',key:aqabaKey,index:b.idx});assert.equal(job.status,'complete');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM aqaba_transfers').get().n,1);
assert.equal(classifySapFile('Document Number\tDocument Date\tBranch\n2617000\t2026-11-14\tالسرو'),'monthly');
const all=await (await route.GET(new Request('https://example.test/api/sap-processing'))).json();assert.ok(all.jobs.length>=6);assert.ok(all.jobs.every(x=>Array.isArray(x.batches)));
assert.deepEqual(sqlite.prepare('SELECT * FROM reconciliations').all(),before);
console.log('PASS: 867 documents, durable failed-batch recovery, no duplicate writes, changed-document-only processing, live receipt validation, lease concurrency/expiry, all-batch completion, separate stock kinds, Aqaba imports, and preserved invoices/cancellation decisions.');
// Compare actual unchanged legacy route in ten-document batches against new
// persistent processing in 50-document batches on the same local SQLite fixture.
// No network latency is simulated. This is a local benchmark, not a production SLA.
const insert=sqlite.prepare('INSERT INTO reconciliations(id,transfer_no,revision_token,branch,driver,doc_date,status,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)');
for(let i=0;i<2000;i++)insert.run('historical-'+i,String(2800000+i),'rev','21','','2026-11-01','match',JSON.stringify({transfers:[{number:String(2800000+i),paste:'historical item rows '.repeat(100)}],invoices:[{number:'2631000001',complete:true}]}),'old','old');
const docs=plan.batches.flatMap(x=>x.items);
const baseline=process.env.SAP_BENCH_BASE_REF?load('app/api/reconcile/route.ts',execFileSync('git',['show',process.env.SAP_BENCH_BASE_REF+':app/api/reconcile/route.ts'],{encoding:'utf8'})):reconcile;
const benchmark=[];
for(let pass=0;pass<3;pass++){
 sqlite.exec('DELETE FROM lieutenant_queue; DELETE FROM sap_document_receipts;');
 const start=performance.now(),beforeScans=scans;
 for(let i=0;i<docs.length;i+=10){const response=await baseline.POST(new Request('https://example.test/api/reconcile',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.test'},body:JSON.stringify({action:'lieutenantImport',sourceFile:key,transfers:docs.slice(i,i+10)})}));assert.equal(response.status,200);await response.json();}
 const oldMs=performance.now()-start,oldScans=scans-beforeScans;
 sqlite.exec('DELETE FROM lieutenant_queue; DELETE FROM sap_document_receipts;');
 const newKey='lieutenant/transfers__'+String(pass+1).repeat(32)+'__bench.txt';
 const newStart=performance.now(),newBeforeScans=scans;let state=await call({action:'start',key:newKey,text});for(const b of state.batches)state=await call({action:'batch',key:newKey,index:b.idx});
 assert.equal(state.status,'complete');const newMs=performance.now()-newStart;
 const repeatStart=performance.now();const repeatScans=scans;await call({action:'start',key:newKey,text});
 benchmark.push({baselineRef:process.env.SAP_BENCH_BASE_REF||'current-route-10-documents',pass:pass+1,documents:867,historicalInvoices:2000,beforeMs:+oldMs.toFixed(2),afterMs:+newMs.toFixed(2),beforeBatches:87,afterBatches:18,beforeLegacyScans:oldScans,afterLegacyScans:scans-newBeforeScans,repeatedFileMs:+(performance.now()-repeatStart).toFixed(2),repeatedFileLegacyScans:scans-repeatScans});
}
console.log('LOCAL_BENCHMARK',JSON.stringify(benchmark));
globalThis.fetch=originalFetch;
