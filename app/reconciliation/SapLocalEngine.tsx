'use client';
import {useEffect,useRef,useState} from 'react';
import {Cpu,FileText,RefreshCw} from 'lucide-react';
import {decodeLieutenantFile} from '../lib/lieutenant-file';
import {sapRequest} from '../lib/sap-files-client';
import type {SapLocalEvent,SapLocalReport,SapLocalReference,SapLocalSnapshot} from '../lib/sap-local-types';

type BaselineResponse={snapshot:SapLocalSnapshot|null;rows:SapLocalReference[];branches:string[]};
export default function SapLocalEngine({onUploadFile}:{onUploadFile:(file:File)=>void}){
 const [file,F]=useState<File|null>(null);
 const [working,W]=useState(false),[phase,P]=useState(''),[error,E]=useState(''),[result,R]=useState<SapLocalReport|null>(null);
 const [snapshot,S]=useState<SapLocalSnapshot|null>(null);
 const workRef=useRef<Worker|null>(null);
 useEffect(()=>()=>{workRef.current?.terminate();workRef.current=null;},[]);
 async function run(){
  if(!file||working)return;
  workRef.current?.terminate();workRef.current=null;
  R(null);S(null);E('');W(true);P('قراءة النسخة المعتمدة للمقارنة…');
  try{
   if(!/\.(txt|tsv|csv)$/i.test(file.name))throw Error('التحليل المحلي يدعم ملف TXT أو TSV أو CSV فقط.');
   if(!file.size||file.size>16*1024*1024)throw Error('حجم الملف يجب ألا يتجاوز 16 ميغابايت.');
   const baseline=await sapRequest<BaselineResponse>('/api/sap-snapshot?comparison=1');
   if(!Array.isArray(baseline.rows)||!Array.isArray(baseline.branches))
    throw Error('الخادم لم يُرجع بيانات المقارنة المكتملة.');
   if(baseline.snapshot&&baseline.snapshot.activeCount!==baseline.snapshot.documents)
    throw Error('عدد الترحيلات المعتمدة غير متطابق؛ المقارنة ممنوعة حتى تصحيح المرجع.');
   S(baseline.snapshot);
   P('التحليل والمقارنة يعملان على جهازك…');
   const text=decodeLieutenantFile(await file.arrayBuffer(),file.name);
   const worker=new Worker(new URL('../lib/sap-local-worker.ts',import.meta.url),{type:'module'});
   workRef.current=worker;
   worker.onmessage=(event:MessageEvent<SapLocalEvent>)=>{
    const message=event.data;
    if(message.type==='progress')P('مقارنة الترحيلات محليًا: '+message.done+' من '+message.total);
    if(message.type==='done'){R(message.report);W(false);P('اكتمل التحليل المحلي. لم تتغير قاعدة البيانات.');worker.terminate();if(workRef.current===worker)workRef.current=null;}
    if(message.type==='error'){E(message.message);W(false);P('');worker.terminate();if(workRef.current===worker)workRef.current=null;}
   };
   worker.onerror=()=>{E('تعذّر تشغيل عامل التحليل المحلي في المتصفح. لم تُغيّر قاعدة البيانات.');W(false);P('');worker.terminate();if(workRef.current===worker)workRef.current=null;};
   worker.postMessage({text,baseline:baseline.rows,branches:baseline.branches});
  }catch(cause){
   E(cause instanceof Error?cause.message:'تعذّر بدء التحليل المحلي.');
   W(false);P('');
  }
 }
 function numbers(label:string,items:string[]){
  if(!items.length)return null;
  return <details><summary>{label} ({items.length===80?'أول 80 رقمًا':items.length+' رقمًا'})</summary>
   <p dir="ltr" style={{overflowWrap:'anywhere'}}>{items.join(' · ')}</p>
  </details>;
 }
 return <section className="panel" aria-label="برنامج محرك SAP المحلي" style={{marginBlock:'1rem'}}>
  <div className="section-title"><h2><Cpu size={19}/> محرك SAP المحلي — فحص الفروقات</h2></div>
  <p>يقرأ TXT على جهازك دون إرسال محتواه للتحليل. يجلب بصمات الترحيلات المعتمدة فقط، ويبيّن الجديد والمعدّل والمطابق والمفقود من الكشف.</p>
  <div className="table-controls">
   <label>ملف SAP الجديد <input type="file" accept=".txt,.tsv,.csv" disabled={working} aria-label="ملف SAP للتحليل المحلي"
    onChange={event=>{F(event.currentTarget.files?.[0]||null);R(null);E('');P('');S(null);}}/></label>
   <button type="button" className="button primary" disabled={!file||working} onClick={()=>void run()}>
    <RefreshCw size={16}/>{working?'جارٍ التحليل…':'حلّل وقارن محليًا'}</button>
  </div>
  {phase&&<p role="status" className="hint">{phase}</p>}
  {error&&<p role="alert" className="banner error">{error}</p>}
  {result&&<div>
   <p><b><FileText size={15}/> {file?.name}</b> · زمن التحليل المحلي: {result.elapsedMs} مللي ثانية · النسخة المرجعية: {snapshot?new Date(snapshot.committed).toLocaleString('ar-JO',{timeZone:'Asia/Amman'}):'غير موجودة'}</p>
   <div className="form-grid" aria-label="خلاصة مقارنة SAP">
    <p><b>إجمالي الترحيلات</b> {result.sourceCount}</p>
    <p><b>جديد</b> {result.added}</p>
    <p><b>معدّل</b> {result.changed}</p>
    <p><b>قديم بلا تغيير</b> {result.unchanged}</p>
    <p><b>غير موجود بالكشف الجديد</b> {result.missing}</p>
    <p><b>حالات للمراجعة</b> {result.issueCount} · مستبعدة من الاستيراد العادي {result.excluded}</p>
   </div>
   {numbers('الترحيلات الجديدة',result.addedNumbers)}
   {numbers('الترحيلات التي تغيّرت',result.changedNumbers)}
   {numbers('ترحيلات مرجعية غير موجودة بالكشف الحالي — لا تُحذف تلقائيًا',result.missingNumbers)}
   {!!result.issues.length&&<details open><summary>ملاحظات تحتاج مراجعة ({result.issueCount})</summary>{result.issues.map((issue,i)=><p className="red" key={i}>{issue}</p>)}</details>}
   {result.missing>0&&<p className="banner warn">غياب ترحيل من الكشف الجديد لا يعني إلغاءه في SAP؛ راجع نطاق التواريخ قبل الاعتماد.</p>}
   <p className="hint">هذه مرحلة تحليل محلي آمن فقط. زر الرفع أدناه يستخدم مسار الاعتماد الحالي الذي يتحقق من الأصل وجميع الترحيلات؛ لا يدّعي إرسال الفروقات فقط أو تسريع الاعتماد قبل اكتمال اختبارات المسار الجديد.</p>
   <button type="button" className="button secondary" disabled={working||!file} onClick={()=>{if(file)onUploadFile(file);}}>
    <FileText size={16}/> رفع الملف واعتماده بالطريقة الموثّقة الحالية</button>
  </div>}
 </section>;
}
