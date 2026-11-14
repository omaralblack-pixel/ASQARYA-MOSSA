'use client';

import {useEffect,useMemo,useState} from 'react';
import {cancellationReviewRows,validateCancellationDecision,
  type CancellationDecision,type CancellationDecisionInput,
  type CancellationDecisionKind,type CancellationRelatedType,
  type CancellationReviewRow} from '../lib/lieutenant-cancellation-decisions';
import type {LieutenantTransfer} from '../lib/lieutenant';

const decisionLabels:Record<CancellationDecisionKind,string>={
  ignore:'تمام — تم تجاوز المراجعة',
  linked:'تم توثيق ارتباط بمستند',
  keep:'اعتراض على الإلغاء — توجد فاتورة تغطيه بحسب مراجعتك',
};
const relatedLabels:Record<Exclude<CancellationRelatedType,''>,string>={
  transfer:'ترحيل SAP',invoice:'فاتورة زرقاء',other:'مستند آخر',
};
type ChangeHandler=(decision:CancellationDecisionInput,expectedRevision:number)=>Promise<void>;
async function requestJson<T>(url:string,init?:RequestInit):Promise<T>{
  let response:Response;
  try{response=await fetch(url,{cache:'no-store',redirect:'manual',...init})}
  catch{throw Error('انقطع الاتصال بالخادم؛ لم يتم تأكيد حفظ القرار.')}
  if(response.status===401||[301,302,303,307,308].includes(response.status)||
    response.type==='opaqueredirect')
    throw Error('انتهت جلسة الدخول؛ افتح المشروع وسجّل الدخول مجددًا.');
  const text=await response.text();
  let data:T&{error?:string};
  try{data=JSON.parse(text) as T&{error?:string}}
  catch{throw Error('استجابة الخادم ليست JSON صالحًا (HTTP '+response.status+'). لم يتم تأكيد الحفظ.')}
  if(!response.ok)throw Error(data.error||'تعذّر الحفظ (HTTP '+response.status+').');
  return data;
}
function CancellationEditor({row,saved,disabled,onSave,onClear,onOpenTransfer}:{
  row:CancellationReviewRow;saved?:CancellationDecision;disabled:boolean;
  onSave:ChangeHandler;onClear:(number:string,revision:number)=>Promise<void>;
  onOpenTransfer:(row:LieutenantTransfer)=>void;
}){
  const [mode,setMode]=useState<''|CancellationDecisionKind>(saved?.decision||'');
  const [relatedType,setRelatedType]=useState<CancellationRelatedType>(saved?.related_type||'');
  const [relatedNumber,setRelatedNumber]=useState(saved?.related_number||'');
  const [note,setNote]=useState(saved?.note||'');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    setMode(saved?.decision||'');
    setRelatedType(saved?.related_type||'');
    setRelatedNumber(saved?.related_number||'');
    setNote(saved?.note||'');
  },[saved?.revision,saved?.decision,saved?.related_type,saved?.related_number,saved?.note]);
  const number=row.source.transfer.number;
  async function save(){
    const parsed=validateCancellationDecision({
      transferNo:number,decision:mode,relatedType:mode==='ignore'?'':mode==='keep'?'invoice':relatedType,
      relatedNumber:mode==='ignore'?'':relatedNumber,note,
    });
    if(!parsed.value){setError(parsed.error||'القرار غير صالح.');return}
    setBusy(true);setError('');
    try{await onSave(parsed.value,saved?.revision||0)}
    catch(cause){setError(cause instanceof Error?cause.message:'تعذّر الحفظ.')}
    finally{setBusy(false)}
  }
  async function clear(){
    if(!saved)return;
    setBusy(true);setError('');
    try{await onClear(number,saved.revision)}
    catch(cause){setError(cause instanceof Error?cause.message:'تعذّر إعادة الفتح.')}
    finally{setBusy(false)}
  }
  return <tr>
    <td dir="ltr"><b>{number}</b><small style={{display:'block'}} dir="ltr">{row.source.transfer.date}</small>
      <div className="no-print"><button type="button" className="button secondary"
        onClick={()=>onOpenTransfer(row.source)}>فتح الترحيل</button></div>
    </td>
    <td>{row.source.branch||'الفرع غير محدد'}<small dir="ltr" style={{display:'block'}}>{row.directions.join('، ')||'—'}</small></td>
    <td>{row.kind}
      <small style={{display:'block'}}>{row.automaticReason}</small>
      {row.counterparts.length>0&&<small style={{display:'block'}} dir="ltr">المقابل من الكشف: {row.counterparts.join('، ')}</small>}
      {!!row.source.invoiceNumbers.length&&<small style={{display:'block'}}>
        أرقام فواتير مذكورة في SAP (ليست إثبات تغطية): {row.source.invoiceNumbers.join('، ')}
      </small>}
      {!!row.source.issues.length&&<p className="red">{row.source.issues.join(' · ')}</p>}
    </td>
    <td>
      {saved?<div><b>{decisionLabels[saved.decision]}</b>
        {!!saved.related_number&&<small style={{display:'block'}}>
          المرجع الذي سجّلته: {saved.related_type?relatedLabels[saved.related_type]||'مستند':''} <b dir="ltr">{saved.related_number}</b>
        </small>}
        {!!saved.note&&<p style={{whiteSpace:'pre-wrap'}}>{saved.note}</p>}
        <small style={{display:'block'}} dir="ltr">حُفظ: {saved.updated_at}</small>
      </div>:row.proven?<b>مستند مقابل مثبت في SAP — لا يحتاج اعتمادًا يدويًا</b>:
        <b>بحاجة قرار — غير محفوظ</b>}
      <div className="no-print" style={{marginTop:8}}>
        <label>قرار المراجعة
          <select value={mode} disabled={disabled||busy} onChange={event=>{
            const next=event.target.value as ''|CancellationDecisionKind;
            setMode(next);setError('');
            if(next==='ignore'){setRelatedType('');setRelatedNumber('')}
            if(next==='keep'){setRelatedType('invoice');setRelatedNumber('')}
          }}>
            <option value="">اختر القرار</option>
            <option value="ignore">تمام — تجاوزها</option>
            <option value="linked">مربوطة بمستند</option>
            <option value="keep">لا يجب إلغاؤها — فاتورة تغطيها</option>
          </select>
        </label>
        {mode==='linked'&&<label>نوع المستند
          <select value={relatedType} disabled={disabled||busy} onChange={event=>{
            setRelatedType(event.target.value as CancellationRelatedType);setRelatedNumber('');setError('');
          }}>
            <option value="">اختر نوع المرجع</option>
            <option value="transfer">ترحيل SAP</option>
            <option value="invoice">فاتورة زرقاء</option>
            <option value="other">مستند آخر</option>
          </select>
        </label>}
        {(mode==='linked'||mode==='keep')&&<label>{mode==='keep'?'رقم الفاتورة الزرقاء التي تغطي الترحيل':'رقم أو وصف المستند المرتبط'}
          <input dir="ltr" value={relatedNumber} maxLength={100} disabled={disabled||busy}
            onChange={event=>{setRelatedNumber(event.target.value);setError('')}}
            placeholder={mode==='keep'||relatedType==='invoice'?'10 أرقام':'رقم المستند أو وصفه'}/>
        </label>}
        {mode!==''&&<label>ملاحظتك (تُحفظ وتظهر في الطباعة)
          <textarea rows={2} value={note} maxLength={600} disabled={disabled||busy}
            onChange={event=>{setNote(event.target.value);setError('')}} placeholder="سبب قرارك أو التوضيح الإضافي"/>
        </label>}
        {!!error&&<p className="red" role="alert">{error}</p>}
        <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
          <button className="button primary" type="button" disabled={disabled||busy||!mode} onClick={()=>void save()}>
            {busy?'جارٍ الحفظ...':'حفظ القرار دائمًا'}
          </button>
          {saved&&<button className="button secondary" type="button" disabled={disabled||busy}
            onClick={()=>void clear()}>إعادة فتح للمراجعة</button>}
        </div>
      </div>
    </td>
  </tr>;
}

export default function CancelledTransferReview({transfers,from,to,onOpenTransfer}:{
  transfers:LieutenantTransfer[];from:string;to:string;
  onOpenTransfer:(row:LieutenantTransfer)=>void;
}){
  const [decisions,setDecisions]=useState<Record<string,CancellationDecision>>({});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [filter,setFilter]=useState<'all'|'pending'|'reviewed'>('all');
  const rows=useMemo(()=>from<=to?cancellationReviewRows(transfers,from,to):[],
    [transfers,from,to]);
  const needsDecision=(row:CancellationReviewRow)=>
    !row.proven&&!decisions[row.source.transfer.number];
  const pending=rows.filter(needsDecision).length;
  const manuallyReviewed=rows.filter(row=>!!decisions[row.source.transfer.number]).length;
  const verified=rows.filter(row=>row.proven&&!decisions[row.source.transfer.number]).length;
  const visible=rows.filter(row=>filter==='all'||
    (filter==='pending'?needsDecision(row):!needsDecision(row)));
  async function refresh(){
    setLoading(true);setError('');
    try{
      const data=await requestJson<{decisions:CancellationDecision[]}>(
        '/api/reconcile?lieutenantCancellationDecisions=1');
      if(!Array.isArray(data.decisions))throw Error('استجابة قرارات الإلغاء ليست بالقالب المتوقع.');
      setDecisions(Object.fromEntries(data.decisions.map(row=>[row.transfer_no,row])));
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر تحميل القرارات المحفوظة.')}
    finally{setLoading(false)}
  }
  useEffect(()=>{void refresh()},[]);
  async function save(decision:CancellationDecisionInput,expectedRevision:number){
    const result=await requestJson<{record:CancellationDecision}>('/api/reconcile',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'lieutenantCancellationDecision',...decision,expectedRevision}),
    });
    if(!result.record||result.record.transfer_no!==decision.transferNo)
      throw Error('لم يُثبت الخادم حفظ القرار؛ حدّث القرارات للتحقق.');
    setDecisions(current=>({...current,[result.record.transfer_no]:result.record}));
  }
  async function clear(number:string,expectedRevision:number){
    const result=await requestJson<{deleted:boolean;transferNo:string}>('/api/reconcile',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'lieutenantCancellationDecision',decision:'clear',
        transferNo:number,expectedRevision}),
    });
    if(!result.deleted||result.transferNo!==number)throw Error('لم يؤكد الخادم إعادة فتح الترحيل.');
    setDecisions(current=>{const copy={...current};delete copy[number];return copy});
  }
  return <section className="panel" aria-label="مراجعة الترحيلات الملغية وحفظ قراراتها">
    <div className="section-title"><div>
      <h2>مراجعة الترحيلات الملغية — قرارات محفوظة</h2>
      <p>تظهر الإلغاءات المثبتة في SAP والحركات التي تشير ملاحظاتها إلى إلغاء دون سبب مثبت. سجّل قرارك مرة واحدة؛ يظهر في كل كشف وطباعة لاحقة.</p>
    </div></div>
    <p className="hint">قرار «تجاوزها» يغلق متابعة هذه الحركة إداريًا فقط. قرار «لا يجب إلغاؤها» يوثّق اعتراضك ورقم الفاتورة، ولا يعيد تفعيل ترحيل ملغى في SAP ولا يغيّر المخزون أو اعتمادات الفواتير. الربط اليدوي لا يعني إثبات المطابقة آليًا.</p>
    <p role="status"><b>{rows.length}</b> حركة إلغاء أو إشارة إلغاء في الفترة · <b>{pending}</b> بحاجة قرار · <b>{manuallyReviewed}</b> قرار محفوظ · <b>{verified}</b> مثبتة بالمستند دون حاجة لقرار يدوي.</p>
    <div className="table-controls no-print">
      <label>عرض القرارات
        <select value={filter} onChange={event=>setFilter(event.target.value as typeof filter)}>
          <option value="all">الكل (بما فيها القرارات المحفوظة)</option>
          <option value="pending">بحاجة قرار</option>
          <option value="reviewed">قرارات محفوظة أو إلغاء مثبت</option>
        </select>
      </label>
      <button type="button" className="button secondary" onClick={()=>void refresh()} disabled={loading}>
        {loading?'جارٍ استرجاع القرارات...':'تحديث القرارات المحفوظة'}
      </button>
    </div>
    {error&&<p className="banner error" role="alert">{error} — لا تعتمد قرارات جديدة قبل استعادة الاتصال.</p>}
    {loading&&<p className="hint">جارٍ قراءة القرارات المحفوظة من قاعدة البيانات...</p>}
    {!!visible.length&&<div className="table-scroll"><table>
      <thead><tr><th>رقم الترحيل وتاريخه</th><th>الفرع والاتجاه</th><th>حالة SAP والدليل</th><th>قرارك المحفوظ وملاحظاتك</th></tr></thead>
      <tbody>{visible.map(row=><CancellationEditor key={row.source.transfer.number}
        row={row} saved={decisions[row.source.transfer.number]} disabled={loading||!!error}
        onSave={save} onClear={clear} onOpenTransfer={onOpenTransfer}/>)}</tbody>
    </table></div>}
    {transfers.length>0&&!rows.length&&<p className="hint">لا توجد حركات إلغاء أو إشارات إلغاء ظاهرة في ملف SAP ضمن التاريخ المحدد.</p>}
    {rows.length>0&&!visible.length&&<p className="hint">لا توجد حركات في هذا الفلتر. اختر «الكل» لعرض القرارات السابقة.</p>}
    {!transfers.length&&<p className="hint">افتح ملف ترحيلات SAP من الأرشيف لعرض حركات الإلغاء.</p>}
  </section>;
}
