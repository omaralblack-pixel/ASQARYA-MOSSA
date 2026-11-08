import fs from 'node:fs';import ts from 'typescript';import assert from 'node:assert/strict';
const source=fs.readFileSync('app/lib/reconcile.ts','utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;const {reconcile,checkSignature,withInvoiceDates,fils,groupReference,moveLinkedPage,pageNumber,monthly,parseTransfer,convert,dateValue}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const ref=JSON.parse(fs.readFileSync('app/reference.json'));assert.ok(ref.length>=65);assert.equal(ref.find(i=>i.sapCode==='FVL00311').cartonPieces,8);
const paste=(rows)=>'Item No.\tItem Description\tIn Stock\tQuantity\tFrom Warehouse\tTo Warehouse\tCommitted\tUoM Name\n'+rows.map(r=>[r[0],'test','99,999',r[1],'1','11','8,888',r[2]].join('\t')).join('\n');
const d={branch:'branch',driver:'',date:'2026-11-03',transfers:[{id:'t1',number:'100',date:'2026-11-01',paste:paste([['FVL00302',1,'Carton']])},{id:'t2',number:'101',date:'2026-11-02',paste:paste([['FVL00302',0.5,'Carton']])}],invoices:[{id:'i1',number:'A',date:'2026-11-01',amount:'7.000',complete:true,quantities:{'11366443':'20'}},{id:'i2',number:'B',date:'2026-11-02',amount:'3.500',complete:true,quantities:{'11366443':'10'}}],notes:''};
let r=reconcile(d,ref);assert.equal(r.status,'match');assert.equal(r.total,10500);assert.equal(r.expected,10500);assert.equal(r.rows[0].transfer,30);assert.equal(r.rows[0].invoice,30);assert.equal(r.rows[0].details.length,2);
let changed=structuredClone(d);changed.invoices[1].quantities['11366443']='9';r=reconcile(changed,ref);assert.equal(r.status,'difference');assert.equal(r.rows[0].difference,-1);
changed=structuredClone(d);changed.invoices[1].amount='3.501';assert.equal(reconcile(changed,ref).priceDifference,1);assert.equal(reconcile(changed,ref).status,'difference');
changed=structuredClone(d);changed.invoices[0].complete=false;assert.equal(reconcile(changed,ref).status,'review');
changed=structuredClone(d);changed.invoices[1].number='A';assert.equal(reconcile(changed,ref).status,'review');changed=structuredClone(d);changed.transfers[1].number='100';assert.equal(reconcile(changed,ref).status,'review');
changed=structuredClone(d);changed.transfers[0].paste=changed.transfers[0].paste.replace('FVL00302','CHS00071');assert.equal(reconcile(changed,ref).review,1);
changed=structuredClone(d);changed.transfers[0].paste=paste([['PFS00003',10,'KG']]);assert.equal(reconcile(changed,ref).rows.find(i=>i.sapCode==='PFS00003').transfer,null);
const piece={...ref.find(i=>i.sapCode==='PFS00003'),kgPerPiece:1};assert.equal(convert({unit:'KG',quantity:10},piece),10);assert.equal(convert({unit:'Piece',quantity:5},ref.find(i=>i.sapCode==='CHS00033')),5);assert.equal(convert({unit:'Carton',quantity:2},ref.find(i=>i.sapCode==='FVL00311')),16);
assert.equal(parseTransfer(paste([['FVL00302',1,'Carton']])).lines[0].quantity,1);assert.equal(parseTransfer(paste([['FVL00302',1,'Carton']]).replace('\t11\t','\t12\t')).excluded.length,1);assert.equal(parseTransfer(paste([['FVL00302',1,'Carton']])+'\n\t\t\t\t1\t11').issues.length,1);
const groups=[{id:'g',branch:'branch',payload:JSON.stringify(d)}];const serial='Document Number\tDocument Date\tBranch\n100\t01/11/2026\tbranch\n101\t02/11/2026\tbranch\n102\t03/11/2026\tbranch\n102\t03/11/2026\tbranch\n999\t31/10/2026\tbranch';let m=monthly(serial,'2026-11',{number:0,date:1,branch:2},false,'dmy',groups);assert.deepEqual(m.missing.map(r=>r.number),['102']);assert.equal(m.received.length,2);assert.equal(m.duplicates.length,1);assert.equal(m.outside.length,1);assert.equal(m.extra.length,0);
changed=structuredClone(d);changed.invoices[0].complete=false;m=monthly(serial,'2026-11',{number:0,date:1,branch:2},false,'dmy',[{id:'g',branch:'branch',payload:JSON.stringify(changed)}]);assert.equal(m.pending.length,2);assert.equal(m.received.length,0);assert.equal(dateValue('31/02/2026'),null);assert.equal(monthly('No\n100','2026-11',{number:0,date:-1,branch:-1},false,'dmy',groups).problems.length,1);
const zeroPrice=ref.map(i=>i.sapCode==='FVL00302'?{...i,price:null}:i);assert.equal(reconcile(d,zeroPrice).status,'quantityMatch');
console.log('PASS: approved institution whitelist; two transfers/two invoices; fractional cartons; 8-pack strawberry; Quantity column isolation; unit-review blocking; duplicate docs; three-decimal prices; monthly missing, pending, duplicate and date boundaries.');

const manual={...structuredClone(d),mode:'manual',pages:{},invoices:d.invoices.map(i=>({...i,quantities:{}}))};
let mr=reconcile(manual,ref);
assert.equal(mr.rows[0].transfer,30);
assert.equal(mr.expected,10500);
assert.equal(mr.status,'match');
assert.equal(pageNumber(manual.pages[mr.rows[0].key]),0);
manual.pages[mr.rows[0].key]='0';
assert.equal(reconcile(manual,ref).status,'match');
manual.pages[mr.rows[0].key]='١';
assert.equal(reconcile(manual,ref).status,'match');
manual.pages[mr.rows[0].key]='3';
assert.equal(reconcile(manual,ref).status,'review');

const combined=structuredClone(d);
combined.transfers=[{...combined.transfers[0],number:'100+101'}];
const combinedGroups=[{id:'g',branch:'branch',payload:JSON.stringify(combined)}];
const noColumns={number:-1,date:-1,branch:-1};
m=monthly('١٠٠\n101\n102\n102','2026-11',noColumns,true,'dmy',combinedGroups);
assert.deepEqual(m.received.map(row=>row.number),['100','101']);
assert.deepEqual(m.missing.map(row=>row.number),['102']);
assert.deepEqual(m.duplicates,['102']);
assert.equal(monthly('100\n101','2026-11',noColumns,false,'dmy',combinedGroups).received.length,0);
assert.equal(monthly(serial.replace('101\t','Document Number\tDocument Date\tBranch\n101\t'),'2026-11',{number:0,date:1,branch:2},false,'dmy',groups).problems.length,0);
console.log('PASS: page zero, Arabic page digits, out-of-range pages, plain M2026 numbers, and previously combined transfer numbers.');

const link={...ref[0],code:'99999999',sapCode:'CFC00007',name:'معكرونة صدفه',price:800};
const draftLink={...manual,pages:{'s:CFC00007':'1','i:other':'2'},transfers:[{...manual.transfers[0],paste:paste([['CFC00007',2,'Piece']])}]};
assert.equal(reconcile(draftLink,ref).rows[0].transfer,null);
const groupRef=groupReference(ref,[{...ref[0],price:999},...ref.slice(1),link],['CFC00007']);
assert.equal(groupRef[0].price,ref[0].price);
draftLink.pages=moveLinkedPage(draftLink.pages,link.sapCode,link.code);
const linkedRow=reconcile(draftLink,groupRef).rows[0];
assert.equal(linkedRow.transfer,2);
assert.equal(linkedRow.expected,1600);
assert.deepEqual(draftLink.pages,{'i:99999999':'1','i:other':'2'});
console.log('PASS: linking updates the existing transfer row and preserves its page and the saved prices of other items.');

assert.equal(fils('664,25'),664250);
assert.equal(fils('٦٦٤،٢٥٠'),664250);
assert.equal(fils('664.25'),664250);
assert.equal(fils('1,664.250'),1664250);
assert.equal(fils('1,664'),1664000);
assert.equal(fils('664,25')-665450,-1200);

const warehousePaste = (rows) => [
  'Item No.\tItem Description\tQuantity\tFrom Warehouse\tTo Warehouse\tUoM Code',
  ...rows.map(([code,quantity,from,to,unit]) => [code,'test',quantity,from,to,unit].join('\t')),
].join('\n');
const reverse = warehousePaste([
  ['FVL00042','0.2','011','001','Carton'],
  ['FVL00109','0.5','011','002','Carton'],
]);
const forward = warehousePaste([
  ['FVL00042','1','001','011','Carton'],
  ['FVL00109','1','002','011','Carton'],
]);
const net = reconcile({...manual, pages:{}, transfers:[
  {...d.transfers[0],paste:forward},
  {...d.transfers[1],paste:reverse},
]},ref);
assert.equal(net.rows.find(row=>row.sapCode==='FVL00042').transfer,8);
assert.equal(net.rows.find(row=>row.sapCode==='FVL00109').transfer,10);
assert.equal(net.expected,20040);
assert.equal(parseTransfer(reverse).excluded.length,2);
assert.equal(parseTransfer(reverse,{allowReverse:true}).excluded.length,0);
const invalidReverse = warehousePaste([['FVL00042','-0.2','011','001','Carton']]);
assert.equal(parseTransfer(invalidReverse,{allowReverse:true}).issues.length,1);
console.log('PASS: reverse transfers subtract converted quantities and value, while bulk intake keeps its forward-only scope.');

const dated = withInvoiceDates({...manual, transfers:[
  {...d.transfers[0],date:'2026-11-01',paste:forward},
  {...d.transfers[1],date:'2026-11-05',paste:forward},
  {...d.transfers[1],number:'102',date:'2026-10-01',paste:reverse},
], invoices:[
  {...manual.invoices[0],date:''},
  {...manual.invoices[1],date:'',dateTransferNos:['101']},
]});
assert.deepEqual(dated.invoices.map(invoice=>invoice.date),['2026-10-31','2026-11-04']);
console.log('PASS: blue invoice dates subtract one calendar day, use linked outgoing transfers, and ignore reverse dates.');

const withDifference = {...manual,pages:{},invoices:manual.invoices.map((invoice,index)=>index===0?{...invoice,amount:'7.001'}:invoice)};
const outstanding = reconcile(withDifference,ref);
assert.equal(outstanding.status,'difference');
const approved = {...withDifference,acceptedDifference:{paper:outstanding.total,calculated:outstanding.expected}};
assert.equal(reconcile(approved,ref).status,'match');
assert.equal(reconcile(approved,ref).priceDifference,1);
assert.equal(reconcile({...approved,invoices:approved.invoices.map((invoice,index)=>index===0?{...invoice,amount:'7.002'}:invoice)},ref).status,'difference');
assert.equal(reconcile({...approved,invoices:approved.invoices.map(invoice=>({...invoice,complete:false}))},ref).status,'review');
console.log('PASS: approving a value difference retains the amount, expires when totals change, and cannot override incomplete review.');

const editedDates = withInvoiceDates({...dated,invoices:[
  {...dated.invoices[0],date:'2026-10-29',manualDate:true},
  {...dated.invoices[1],date:'',manualDate:false},
]});
assert.deepEqual(editedDates.invoices.map(invoice=>invoice.date),['2026-10-29','2026-11-04']);
assert.equal(withInvoiceDates({...editedDates,invoices:[{...editedDates.invoices[0],manualDate:false}]}).invoices[0].date,'2026-10-31');
console.log('PASS: manual invoice date survives recalculation and can return to automatic mode.');

const mixedWarehouses = warehousePaste([
  ['FVL00042','1','001','011','Carton'],
  ['FVL00042','1','009','011','Carton'],
  ['FVL00042','1','011','009','Carton'],
]);
const mixedParsed = parseTransfer(mixedWarehouses,{allowReverse:true});
assert.deepEqual(mixedParsed.lines.map(line=>line.from),['001','009','011']);
assert.equal(mixedParsed.excluded.length,0);
assert.equal(reconcile({...manual,transfers:[{...d.transfers[0],paste:mixedWarehouses}]},ref).rows[0].transfer,10);
console.log('PASS: mixed 001 and 009 lines into 011 are both included.');

// Exclusion affects only the current group and never deletes its SAP lines.
{
 const transferPaste=paste([['DAR00047',2,'Piece'],['FVL00302',1,'Carton']]);
 const fixture={...structuredClone(d),mode:'manual',transfers:[{...d.transfers[0],paste:transferPaste}],invoices:[{...d.invoices[0],amount:'7.000'}]};
 const localRef=ref.filter(item=>item.sapCode!=='DAR00047');
 const initial=reconcile(fixture,localRef),unknown=initial.rows.find(row=>row.sapCode==='DAR00047');
 assert.ok(unknown);assert.equal(initial.review,1);
 const exclusions={[unknown.key]:checkSignature(unknown)};
 const excluded=reconcile({...fixture,excludedItems:exclusions},localRef);
 assert.equal(excluded.review,0);assert.equal(excluded.expected,7000);assert.equal(excluded.excludedRows.length,1);assert.equal(excluded.parsed.lines.length,2);
 assert.equal(reconcile({...fixture,excludedItems:{}},localRef).review,1);
 const changedPaste=transferPaste.replace('DAR00047\ttest\t99,999\t2','DAR00047\ttest\t99,999\t4');
 assert.notEqual(changedPaste,transferPaste);
 const changed=reconcile({...fixture,excludedItems:exclusions,transfers:[{...fixture.transfers[0],paste:changedPaste}]},localRef);
 assert.equal(changed.review,1);assert.equal(changed.excludedRows.length,0);
}
