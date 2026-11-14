import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const js=ts.transpileModule(fs.readFileSync('app/lib/json-request.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
const {readJsonRequest}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const request=body=>new Request('https://example.test/api/reconcile',{method:'POST',body});
assert.deepEqual(await readJsonRequest(request('{"action":"save","notes":"فاتورة"}')),{action:'save',notes:'فاتورة'});
for(const invalid of ['null','[]','{bad','42'])await assert.rejects(readJsonRequest(request(invalid)),error=>error.status===400);
await assert.rejects(readJsonRequest(request('{"notes":"'+'أ'.repeat(20)+'"}'),25),error=>error.status===413);
let canceled=false,part=0;
const stream=new ReadableStream({
 pull(controller){controller.enqueue(new Uint8Array(20));part++;if(part>100)controller.close()},
 cancel(){canceled=true},
});
const streamed=new Request('https://example.test/api/reconcile',{method:'POST',duplex:'half',body:stream});
await assert.rejects(readJsonRequest(streamed,30),error=>error.status===413);
assert.ok(canceled,'An oversized streaming request must be canceled');
const bytes=new TextEncoder().encode('{"notes":"فاتورة"}');
let index=0;
const split=new Request('https://example.test/api/reconcile',{method:'POST',duplex:'half',body:new ReadableStream({
 pull(controller){if(index<bytes.length)controller.enqueue(bytes.slice(index,index++ +1));else controller.close()},
})});
assert.equal((await readJsonRequest(split)).notes,'فاتورة','UTF-8 characters may span stream chunks');
console.log('PASS: bounded JSON requests, Arabic UTF-8 chunks, missing Content-Length, stream cancellation and clear 400/413 errors');
