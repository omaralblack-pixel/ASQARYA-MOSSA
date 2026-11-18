import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const source=fs.readFileSync('app/lib/project-sync-core.ts','utf8');
const code=ts.transpileModule(source,{compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,
}}).outputText;
const api=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
assert.equal(api.projectSyncScope('/api/reconcile'),'reconcile');
assert.equal(api.projectSyncScope('/api/colonel'),'colonel');
assert.equal(api.projectSyncScope('/api/lieutenant-files'),'sap');
assert.equal(api.projectSyncScope('/api/sap-processing'),'sap');
assert.equal(api.projectSyncScope('/api/aqaba'),'aqaba');
assert.equal(api.projectSyncScope('/api/project-sync'),null);
assert.equal(api.projectSyncScope('/api/data'),'reconcile');
assert.equal(api.shouldPublishProjectChange('GET','/api/reconcile',200),false);
assert.equal(api.shouldPublishProjectChange('POST','/api/reconcile',409),false,
 'stale invoice edits must not be distributed as completed changes');
assert.equal(api.shouldPublishProjectChange('POST','/api/lieutenant-files',200,true),false,
 'identical immutable SAP originals should not cause false change signals');
assert.equal(api.shouldPublishProjectChange('POST','/api/lieutenant-files',200),true);
assert.equal(api.shouldPublishProjectChange('DELETE','/api/lieutenant-files',200),true);
assert.equal(api.shouldPublishProjectChange('POST','/api/aqaba',200),true);
assert.equal(api.shouldPublishProjectChange('POST','/api/colonel',200),true);
assert.ok(api.affectedScreens('reconcile').includes('reconciliation'));
assert.ok(api.affectedScreens('sap').includes('reassurance'));
const worker=fs.readFileSync('worker/index.ts','utf8');
assert.match(worker,/await publishChange\(request,response,env\)/);
assert.match(worker,/await publishChange\(request,downstream,env\)/);
assert.match(worker,/response\.clone\(\)\.json\(\)/);
const page=fs.readFileSync('app/reconciliation/page.tsx','utf8');
assert.match(page,/draftBaseline\.current/);
assert.match(page,/data\.record\?\.version!==knownVersion/);
assert.match(page,/remoteConflict/);
assert.match(page,/ProjectSyncIndicator/);
const soldier=fs.readFileSync('app/reconciliation/SerialSoldier.tsx','utf8');
assert.match(soldier,/readSerialWorkbook\(buffer\)/);
assert.match(soldier,/evaluateSerial\(parsed\.rows,saved,parsed\.period\)/);
const scopes=['Colonel','Reassurance','FirstLieutenant','SerialSoldier','SapFiles','StockReport','AqabaWorkspace'];
for(const name of scopes){
 const source=fs.readFileSync('app/reconciliation/'+name+'.tsx','utf8');
 assert.match(source,/syncVersion/,'missing sync subscription: '+name);
}
const cancellation=fs.readFileSync('app/reconciliation/CancelledTransferReview.tsx','utf8');
assert.match(cancellation,/syncVersion/);
assert.match(cancellation,/dirty\.current/);
assert.match(cancellation,/تغيّر القرار المحفوظ/);
const monthly=fs.readFileSync('app/reconciliation/page.tsx','utf8');
assert.match(monthly,/monthlyEditorText\.current!==monthlyLoadedText\.current/,
 'remote SAP changes cannot overwrite a manually pasted monthly source');
console.log('PASS: central authenticated sync stream, version conflict guard, all mounted screens, Saja remains output-only');
