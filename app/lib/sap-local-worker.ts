/// <reference lib="webworker" />
import {isUnifiedSapSource,splitUnifiedSapSource} from './unified-sap-query';
import {parseLieutenantTransfers} from './lieutenant';
import {lieutenantImportPlan} from './lieutenant-import-plan';
import type {SapLocalRequest,SapLocalEvent,SapLocalReport} from './sap-local-types';

const scope=self as DedicatedWorkerGlobalScope;
const reply=(message:SapLocalEvent)=>scope.postMessage(message);
const encoder=new TextEncoder();
async function hashPayload(value:unknown){
 const bytes=await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)));
 return Array.from(new Uint8Array(bytes),part=>part.toString(16).padStart(2,'0')).join('');
}
async function analyze(request:SapLocalRequest):Promise<SapLocalReport>{
 const started=performance.now();
 if(!request||typeof request.text!=='string'||request.text.length>25*1024*1024)
  throw Error('ملف SAP غير صالح أو يتجاوز حد التحليل الآمن.');
 const unified=isUnifiedSapSource(request.text);
 const text=unified?splitUnifiedSapSource(request.text).transfers:request.text;
 const scan=parseLieutenantTransfers(text,Array.isArray(request.branches)?request.branches:[]);
 if(!scan.transfers.length)throw Error(scan.issues.join('، ')||'لم يتم العثور على ترحيلات 011.');
 const numbers=new Set<string>();
 for(const row of scan.transfers){
  if(numbers.has(row.transfer.number))throw Error('رقم ترحيل مكرر بعد التحليل: '+row.transfer.number);
  numbers.add(row.transfer.number);
 }
 const base=new Map<string,string>();
 for(const row of request.baseline||[]){
  if(!/^\d{4,20}$/.test(row.number)||!/^[a-f0-9]{64}$/.test(row.hash)||base.has(row.number))
   throw Error('بيانات مقارنة النسخة المعتمدة غير متسقة؛ أوقف التحليل.');
  base.set(row.number,row.hash);
 }
 const classifications=lieutenantImportPlan(scan.transfers,'0001-01-01','9999-12-31');
 const report:SapLocalReport={
  sourceCount:scan.transfers.length,baselineCount:base.size,added:0,changed:0,unchanged:0,missing:0,
  excluded:classifications.filter(x=>x.state==='excluded').length,
  reverse:scan.transfers.filter(x=>x.reverse).length,
  canceled:scan.transfers.filter(x=>x.cancellationState==='canceled'||x.cancellationState==='cancellation').length,
  issueCount:scan.issues.length+scan.transfers.filter(x=>x.issues.length).length,
  issues:[...scan.issues,...scan.transfers.flatMap(x=>x.issues.map(issue=>'الترحيل '+x.transfer.number+': '+issue))].slice(0,80),
  addedNumbers:[],changedNumbers:[],missingNumbers:[],excludedNumbers:classifications.filter(x=>x.state==='excluded').map(x=>x.number).slice(0,80),
  sourceKind:unified?'unified':'transfers',elapsedMs:0,
 };
 for(let start=0;start<scan.transfers.length;start+=64){
  const portion=scan.transfers.slice(start,start+64);
  const hashes=await Promise.all(portion.map(hashPayload));
  for(let i=0;i<portion.length;i++){
   const number=portion[i].transfer.number,prior=base.get(number);
   if(prior===undefined){report.added++;if(report.addedNumbers.length<80)report.addedNumbers.push(number);}
   else if(prior===hashes[i])report.unchanged++;
   else{report.changed++;if(report.changedNumbers.length<80)report.changedNumbers.push(number);}
  }
  reply({type:'progress',done:Math.min(start+64,scan.transfers.length),total:scan.transfers.length});
 }
 for(const number of base.keys())if(!numbers.has(number)){
  report.missing++;
  if(report.missingNumbers.length<80)report.missingNumbers.push(number);
 }
 report.elapsedMs=Math.round(performance.now()-started);
 return report;
}
scope.onmessage=async (event:MessageEvent<SapLocalRequest>)=>{
 try{reply({type:'done',report:await analyze(event.data)});}
 catch(error){reply({type:'error',message:error instanceof Error?error.message:'تعذّر تحليل ملف SAP على جهازك.'});}
};
