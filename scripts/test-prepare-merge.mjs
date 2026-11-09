import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const rec=url(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const {reconcile}=await import(rec);const {prepareGroupMerge}=await import(url(compile(fs.readFileSync('app/lib/prepare-merge.ts','utf8').replace("'./reconcile'","'"+rec+"'"))));
const h='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const t=(n,q,f,w)=>({id:n,number:n,date:'2026-11-02',paste:h+'\nFVL00302\tpeas\t'+q+'\tCarton\t'+f+'\t'+w});
const i={id:'i',number:'',date:'2026-11-01',amount:'',complete:false,quantities:{},attachments:[]};
const ref=[{code:'11366443',sapCode:'FVL00302',name:'peas',price:350,cartonPieces:20,invoicePack:null,sapUnit:'Carton',kgPerPiece:null,active:true}];
const a={id:'a',version:1,mode:'manual',branch:'56',driver:'',date:'2026-11-02',transfers:[t('2615777',5,'001','011')],invoices:[i],notes:'first',referenceSnapshot:ref};
const b={...a,id:'b',transfers:[t('2615778',1,'001','011')],notes:'second'};
const c=prepareGroupMerge(a,b,t('2615914',0.05,'011','001'),'2631202691');
assert.equal(c.transfers.length,3);assert.equal(c.invoices[0].number,'2631202691');assert.equal(reconcile(c,ref).rows[0].transfer,119);assert.equal(c.notes,'first\nsecond');assert.equal(a.transfers.length,1);
assert.throws(()=>prepareGroupMerge(a,{...b,invoices:[{...i,amount:'1'}]},t('2615914',1,'011','001'),'bad'));
assert.throws(()=>prepareGroupMerge(a,{...b,branch:'other'},t('2615914',1,'011','001'),'2631202691'));
console.log('PASS: merge preview, reverse subtraction, originals preserved, conflict rejection');


const p={...a,invoices:[{...i,number:'2622003541',amount:'250.510',complete:true}],transfers:[t('2615809',1,'001','011')]};
const q={...b,transfers:[t('2615810',1,'001','011')]};
const ordinary=prepareGroupMerge(p,q,null,'2622003541');
assert.deepEqual(ordinary.transfers.map(x=>x.number),['2615809','2615810']);
assert.equal(ordinary.invoices.length,1);assert.equal(ordinary.invoices[0].amount,'250.510');assert.equal(ordinary.invoices[0].complete,true);
assert.throws(()=>prepareGroupMerge(p,{...q,transfers:[t('2615809',1,'001','011')]},null,'2622003541'));
assert.throws(()=>prepareGroupMerge(p,{...q,invoices:[{...i,number:'2622003541',amount:'99'}]},null,'2622003541'));
assert.throws(()=>prepareGroupMerge(p,{...q,invoices:[{...i,attachments:[{key:'receipt'}]}]},null,'2622003541'));
console.log('PASS: ordinary merge preserves invoice and rejects conflicting groups');
