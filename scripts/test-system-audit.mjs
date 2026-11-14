import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Compile the actual pure application modules, including their dependencies.
// Baseline mode proves that these cases catch defects in the previous commit.
const baseline=process.env.AUDIT_TEST_BASELINE==='1';
const cache=new Map();
function moduleUrl(file){
  if(cache.has(file))return cache.get(file);
  const source=baseline?execFileSync('git',['show','HEAD:'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const linked=compiled.replace(/from ['"](\.[^'"]+)['"]/g,(_,relative)=>{
    const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(file),relative+'.ts'));
    return 'from '+JSON.stringify(moduleUrl(dependency));
  });
  const url='data:text/javascript;base64,'+Buffer.from(linked).toString('base64');
  cache.set(file,url);return url;
}
const load=file=>import(moduleUrl('app/lib/'+file+'.ts'));
const core=await load('reconcile');
const replacement=await load('catalog-replacement');
const sap=await load('sap-import');
const register=await load('sap-invoice-register');
const lieutenant=await load('lieutenant');
const stock=await load('lieutenant-stock');
const net=await load('stock-report');
const serial=await load('serial-soldier');
const collector=await load('invoice-collector');
const history=await load('history-export');
let failed=0,passed=0;
function check(name,fn){try{fn();passed++;console.log('PASS:',name)}catch(error){failed++;console.error('FAIL:',name,'—',error.message.split('\n')[0])}}

const invoices=[{id:'i1',number:'2624002303',amount:'1.000',date:'2026-11-01',manualDate:false,complete:true,quantities:{}},
 {id:'i2',number:'2624002304',amount:'2.000',date:'2026-11-02',manualDate:true,complete:true,quantities:{}}];
check('Editing one invoice date preserves every other date and manual flag',()=>{
 const before=JSON.stringify(invoices),next=core.editInvoiceDate(invoices,'i1','2026-11-04');
 assert.equal(next[0].date,'2026-11-04');assert.equal(next[0].manualDate,true);
 assert.strictEqual(next[1],invoices[1]);assert.equal(JSON.stringify(invoices),before);
});
check('Clearing one manual date does not clear other invoices',()=>{
 const next=core.editInvoiceDate(invoices,'i2','');
 assert.equal(next[1].manualDate,false);assert.strictEqual(next[0],invoices[0]);
});
const reference=[{code:'11371486',sapCode:'DAR00005',name:'Institution name',active:true,price:1550,sapUnit:'Piece',
 cartonPieces:20,kgPerPiece:null,invoicePack:1,sapAliases:[{sapCode:'DAR00027',sapUnit:'Carton',cartonPieces:24,kgPerPiece:null}]}];
check('Updating an SAP alias retains the primary code, price, name and primary pack',()=>{
 const inputs=replacement.parseReplacementText('Item No.\tحبات الكرتونة\nDAR00027\t36').rows;
 const preview=replacement.previewReplacements(inputs,reference);
 assert.equal(preview[0].status,'ready');
 const updated=replacement.applyReplacements(reference,preview,[2])[0];
 assert.deepEqual({...updated,sapAliases:reference[0].sapAliases},reference[0]);
 assert.equal(updated.sapAliases[0].cartonPieces,36);
 assert.equal(reference[0].sapAliases[0].cartonPieces,24);
});
check('Alias conversions require the alias conversion factor',()=>{
 const refs=[{...reference[0],sapAliases:[{sapCode:'DAR00027',sapUnit:'Piece',cartonPieces:null,kgPerPiece:null}]}];
 const inputs=replacement.parseReplacementText('رقم المادة\tItem No.\tUoM Code\n11371486\tDAR00027\tKG').rows;
 assert.equal(replacement.previewReplacements(inputs,refs)[0].status,'error');
});
check('Signed quantities support Arabic digits and strict separators',()=>{
 assert.equal(core.signedNumeric('−١٬٢٣٤٫٥'),-1234.5);
 assert.equal(core.signedNumeric('1,2'),null);assert.equal(core.signedNumeric('--1'),null);
 assert.equal(core.numeric('-1'),null,'Invoice quantities stay nonnegative');
});
const itemHeader='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const sourceHeader='رقم الترحيل\tتاريخ الترحيل\tكود الفرع\tاسم الفرع\tRemarks\t'+itemHeader;
const sourceRow=(qty,code='DAR00005',warehouse='011')=>['2617000','2026-11-02','1','Branch','2624002303',code,'Test',qty,'Piece','001',warehouse].join('\t');
const negative=[sourceHeader,sourceRow('−٢')].join('\n');
check('Negative SAP corrections cannot become ordinary imported invoices',()=>{
 const result=sap.parseSapImport(negative,['1 — Branch']);
 assert.equal(result.groups[0].reversal,true);assert.equal(result.groups[0].members[0].invoices.length,0);
});
check('Negative corrections are excluded from the saved SAP invoice register',()=>{
 const result=register.sapInvoicesFromSavedFile(negative);
 assert.equal(result.invoices.length,0);assert.equal(result.ignoredCount,1);
});
check('Malformed SAP quantities are disclosed and never linked to invoices',()=>{
 const result=register.sapInvoicesFromSavedFile([sourceHeader,sourceRow('1,2')].join('\n'));
 assert.equal(result.invoices.length,0);assert.ok(result.issues.length);
});
check('Arabic opening stock and warehouse digits retain exact quantities',()=>{
 const parsed=stock.parseLieutenantStock('رقم الصنف\tالمستودع\tوحدة المخزون\tالرصيد الافتتاحي\nDAR00005\t٠١١\tPiece\t١٬٢٣٤٫٥','opening');
 assert.equal(parsed.items[0]?.quantity,1234.5);assert.deepEqual(parsed.issues,[]);
});
check('Malformed grouping in stock quantities cannot silently change the balance',()=>{
 const parsed=stock.parseLieutenantStock('رقم الصنف\tالمستودع\tوحدة المخزون\tالرصيد الفعلي\nDAR00005\t011\tPiece\t1,2','balance');
 assert.equal(parsed.items.length,0);assert.ok(parsed.issues.length);
});
check('Normalized SAP quantities remain readable by every downstream stock calculation',()=>{
 const parsed=lieutenant.parseLieutenantTransfers([sourceHeader,sourceRow('١٬٢٣٤٫٥')].join('\n'),['1 — Branch']);
 assert.equal(parsed.transfers[0].transfer.paste.split('\n')[1].split('\t')[2],'1234.5');
 const rows=stock.auditLieutenantStock([{code:'DAR00005',name:'Test',warehouse:'011',unit:'Piece',quantity:1234.5}],[],parsed.transfers,new Set(),'2026-11-01','2026-11-03',[],undefined,true);
 assert.equal(rows[0].incoming,1234.5);assert.equal(rows[0].difference,0);
});
check('Net stock report rejects invalid item codes',()=>{
 const result=net.stockReport([sourceHeader,sourceRow('1','BROKEN')].join('\n'));
 assert.equal(result.items.length,0);assert.ok(result.issues.length);
});
const move=(number,date,qty,from,to,state,remarks='')=>({
 transfer:{id:number,number,date,paste:itemHeader+'\n'+['DAR00005','Test',qty,'Piece',from,to].join('\t')},
 branch:'Branch',remarks,lineCount:1,reverse:from==='011',cancellationState:state,issues:[],invoiceNumbers:[],
});
const canceledOriginal=move('2617100','2026-11-01',10,'001','011','canceled');
const cancellation=move('2617101','2026-11-03',10,'011','001','cancellation','Inventory transfer no. 2617100 has been canceled');
const balance=quantity=>[{code:'DAR00005',name:'Test',warehouse:'011',unit:'Piece',quantity}];
check('A later SAP cancellation cannot erase the original historical receipt',()=>{
 const row=stock.auditLieutenantStock(balance(10),[],[canceledOriginal,cancellation],new Set(),'2026-11-01','2026-11-02',[],undefined,true)[0];
 assert.equal(row.estimated,10);assert.equal(row.difference,0);
});
check('A cancellation in the selected period offsets an opening balance from the earlier receipt',()=>{
 const row=stock.auditLieutenantStock(balance(0),balance(10),[canceledOriginal,cancellation],new Set(),'2026-11-03','2026-11-03')[0];
 assert.equal(row.outgoing,10);assert.equal(row.estimated,0);assert.equal(row.difference,0);
});
check('A full cancellation pair within one period has zero stock effect',()=>{
 const row=stock.auditLieutenantStock(balance(0),[],[canceledOriginal,cancellation],new Set(),'2026-11-01','2026-11-03',[],undefined,true)[0];
 assert.equal(row.netTransfers,0);assert.equal(row.difference,0);
});
check('An undated or unproven canceled flag cannot produce a false match',()=>{
 const row=stock.auditLieutenantStock(balance(0),[],[canceledOriginal],new Set(),'2026-11-01','2026-11-03',[],undefined,true)[0];
 assert.equal(row.movementComplete,false);assert.equal(row.difference,null);
});
check('Partial or unrelated cancellations never prove a complete stock cancellation',()=>{
 const wrong={...cancellation,transfer:{...cancellation.transfer,paste:cancellation.transfer.paste.replace('\t10\t','\t9\t')}};
 const row=stock.auditLieutenantStock(balance(0),[],[canceledOriginal,wrong],new Set(),'2026-11-01','2026-11-03',[],undefined,true)[0];
 assert.equal(row.movementComplete,false);assert.equal(row.difference,null);
});
const bad=[null,{invoices:[null],transfers:[]},{invoices:[],transfers:['invalid']},{invoices:[{number:42}],transfers:[]}]
 .map((value,index)=>({id:'broken-'+index,branch:'Branch',status:'review',payload:JSON.stringify(value)}));
check('Serial review reports damaged records without crashing or changing them',()=>{
 const before=JSON.stringify(bad),result=serial.evaluateSerial([],bad);
 assert.equal(result.blockers.length,bad.length);assert.equal(JSON.stringify(bad),before);
});
check('Invoice collection counts damaged nested records without crashing',()=>{
 const result=collector.collectInvoicesByDate(bad,'2026-11-01','2026-11-03');
 assert.equal(result.unreadableRecords,bad.length);assert.equal(result.rows.length,0);
});
check('Invoice-free cards stay visible without inflating invoice or inferred-date counts',()=>{
 const report={rows:[{number:'2624002303',dateSource:'manual'},{number:'',dateSource:'transfer'},{number:'0',dateSource:'transfer'}]};
 assert.deepEqual(collector.collectedInvoiceCounts(report),{invoices:1,withoutNumber:2,inferredDates:0});
});
check('SAP register comparison survives damaged saved records',()=>{
 const source=register.sapInvoicesFromSavedFile([sourceHeader,sourceRow('1')].join('\n'));
 assert.equal(register.compareSapWithSavedInvoices(source,bad)[0].state,'missing');
});
check('Monthly comparison identifies corrupted records instead of crashing',()=>{
 const result=core.monthly('2617000','2026-11',{number:0,date:-1,branch:-1},true,'dmy',bad);
 assert.equal(result.problems.length,bad.length);
});
check('Full history export never silently omits damaged records',()=>{
 assert.throws(()=>history.historyExportRows(bad),/تعذّر تصدير السجل/);
});
console.log(`System audit regression checks: ${passed} passed, ${failed} failed${baseline?' (previous commit)':''}.`);
if(failed)process.exitCode=1;
