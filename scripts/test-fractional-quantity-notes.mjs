import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';

const source=fs.readFileSync('app/lib/fractional-quantity-notes.ts','utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {fractionalQuantityNotes}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));

const carton=(quantity,transferNo)=>({quantity,transferNo,unit:'Carton',sapCode:'FOD00001',name:'FAGIOLINI',row:1,from:quantity<0?'011':'002',to:quantity<0?'002':'011'});
const base={key:'i:11356461',code:'11356461',sapCode:'FOD00001',name:'FAGIOLINI LISCI',transfer:23.016,
 unitPrice:790,item:{cartonPieces:24},errors:[],details:[carton(1,'2616605'),carton(-0.041,'2616697')]};
let notes=fractionalQuantityNotes([base]);
assert.equal(notes.length,1);
assert.equal(notes[0].sapQuantity,23.016);
assert.equal(notes[0].nearestWholePiece,23);
assert.equal(notes[0].pieceDifference,0.016);
assert.equal(notes[0].amountDifferenceFils,13);
assert.equal(notes[0].suspectedSapRounding,true);
assert.deepEqual(notes[0].transferNos,['2616697']);

notes=fractionalQuantityNotes([{...base,key:'more',transfer:24.984,details:[carton(1,'original'),carton(0.041,'2617000')]}]);
assert.equal(notes[0].pieceDifference,-0.016);
assert.equal(notes[0].amountDifferenceFils,-13);
assert.equal(notes[0].suspectedSapRounding,true);

notes=fractionalQuantityNotes([{...base,key:'real-fraction',transfer:1.5,item:{cartonPieces:3},details:[carton(0.5,'genuine')]}]);
assert.equal(notes[0].suspectedSapRounding,false,'A legitimate half carton must not be assumed to be a rounding error');

notes=fractionalQuantityNotes([{...base,key:'no-price',unitPrice:null},{...base,key:'invalid',errors:['unknown SAP unit']}]);
assert.equal(notes.length,1,'Unresolved mapping errors cannot be described as rounding');
assert.equal(notes[0].amountDifferenceFils,null);

assert.equal(fractionalQuantityNotes([{...base,transfer:23,details:[carton(1,'2616605')]}]).length,0);
console.log('PASS: fractional quantity notes, 13-fils SAP example, both directions, real fractional cartons, unmapped rows and zero fractions.');
