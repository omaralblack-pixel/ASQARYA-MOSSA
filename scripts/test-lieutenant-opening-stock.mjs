import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// The stock audit imports types only; transpilation runs the real business logic.
const source=fs.readFileSync('app/lib/lieutenant-stock.ts','utf8');
const transpiled=ts.transpileModule(source,{
  fileName:'app/lib/lieutenant-stock.ts',
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  reportDiagnostics:true,
});
assert.deepEqual(transpiled.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error)||[],[]);
const exports={};
new Function('exports','require',transpiled.outputText)(exports,()=>{throw Error('Unexpected runtime import')});
const {auditLieutenantStock}=exports;
const row=(code,quantity,unit='Piece')=>({code,name:code,warehouse:'011',unit,quantity});
const audit=(closing,opening,confirmed)=>auditLieutenantStock(
  closing,opening,[],new Set(),'2026-11-01','2026-11-12',[],undefined,confirmed,
);

// Missing from a confirmed baseline is precisely zero; arithmetic must continue.
const confirmed=audit(
  [row('FVL00368',5),row('CHS00066',7)],
  [row('CHS00066',2)],true);
const absent=confirmed.find(x=>x.code==='FVL00368');
assert.equal(absent.opening,0);
assert.equal(absent.openingAssumedZero,true);
assert.equal(absent.estimated,0);
assert.equal(absent.difference,5);
const present=confirmed.find(x=>x.code==='CHS00066');
assert.equal(present.opening,2);
assert.equal(present.openingAssumedZero,false);
assert.equal(present.difference,5);

// A missing/unconfirmed opening baseline is unknown, not zero.
const unconfirmed=audit([row('FVL00368',5)],[],false)[0];
assert.equal(unconfirmed.opening,null);
assert.equal(unconfirmed.openingAssumedZero,false);
assert.equal(unconfirmed.estimated,null);
assert.equal(unconfirmed.difference,null);

// Existing opening code with incompatible UoM must remain unresolved.
const incompatible=audit([row('CHS00066',7)],[row('CHS00066',2,'KG')],true)[0];
assert.equal(incompatible.opening,null);
assert.equal(incompatible.openingAssumedZero,false);
assert.equal(incompatible.estimated,null);
assert.ok(incompatible.issues.some(note=>note.includes('وحدة')));

// Actual SAP balance absence must never become a fabricated zero.
const noActual=audit([row('CHS00066',7)],[
  row('CHS00066',2),row('FVL00368',5)
],true).find(x=>x.code==='FVL00368');
assert.equal(noActual.quantity,null);
assert.equal(noActual.difference,null);

console.log('11/01 confirmed opening snapshot missing-item-zero regression tests passed.');
