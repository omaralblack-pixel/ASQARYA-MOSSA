import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Seed the actual screen's initial feedback state. Effects and all network /
// business writes remain disabled in SSR; render every real section unchanged.
function screenWithFeedback(field,value){
 const cache=new Map();
 function load(file){
  file=resolve(file);if(!fs.existsSync(file)&&file.endsWith('.ts'))file=file.slice(0,-3)+'.tsx';
  if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
  const source=fs.readFileSync(file,'utf8');
  const seed=context=>{
   function visit(node){
    if(file.endsWith('FirstLieutenant.tsx')&&ts.isVariableDeclaration(node)&&ts.isArrayBindingPattern(node.name)&&
      node.name.elements[0]?.name?.getText()===field&&node.initializer&&ts.isCallExpression(node.initializer)){
     return ts.factory.updateVariableDeclaration(node,node.name,node.exclamationToken,node.type,
      ts.factory.updateCallExpression(node.initializer,node.initializer.expression,node.initializer.typeArguments,[ts.factory.createStringLiteral(value)]));
    }
    return ts.visitEachChild(node,visit,context);
   }
   return root=>ts.visitNode(root,visit);
  };
  const js=ts.transpileModule(source,{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX},transformers:{before:[seed]}}).outputText;
  new Function('exports','require',js)(exports,name=>name.startsWith('.')&&!name.endsWith('.json')?load(resolve(dirname(file),name+'.ts')):createRequire(file)(name));return exports;
 }
 return load('app/reconciliation/FirstLieutenant.tsx').default;
}
let passed=0;
for(const [field,text,role] of [['error','تعذّر اختبار قراءة أصل SAP','alert'],['message','تم اختبار تحديث أصل SAP','status']]){
 const Screen=screenWithFeedback(field,text);
 for(const section of ['transfers','day','balance','opening','query','cashvan','cancellations']){
  const html=renderToStaticMarkup(React.createElement(Screen,{section,branches:[],reference:[],onOpenRecord(){},onOpenTransfer(){}}));
  assert.ok(html.includes(text),`${field} must remain visible in ${section}`);
  assert.equal(html.split(text).length-1,1,`${field} must render once in ${section}`);
  assert.ok(new RegExp('role="'+role+'"[^>]*>[^<]*'+text).test(html),`Use ${role} for ${field} in ${section}`);
  passed++;
 }
}
console.log(`PASS: ${passed} actual lieutenant section renders expose errors and success feedback without network or business writes.`);
