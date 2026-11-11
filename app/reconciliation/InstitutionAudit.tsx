'use client';

import {useState} from 'react';
import {CalendarDays,Download,FileSearch,FolderOpen,AlertTriangle} from 'lucide-react';
import {dateValue} from '../lib/reconcile';
import {tableWorkbook} from '../lib/invoice-workbook';
import type {CollectedInvoiceResult,CollectedInvoice,UndatedInvoice} from '../lib/invoice-collector';

export default function InstitutionAudit({onOpenInvoice}:{
  onOpenInvoice:(recordId:string,invoiceId:string)=>Promise<void>;
}){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Amman'});
  const [dateFrom,setDateFrom]=useState(today.slice(0,8)+'01');
  const [dateTo,setDateTo]=useState(today);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [opening,setOpening]=useState('');
  const [openError,setOpenError]=useState('');
  const [report,setReport]=useState<CollectedInvoiceResult|null>(null);

  async function collect(){
    const from=dateValue(dateFrom),to=dateValue(dateTo);
    if(!from||!to){setError('اختر تاريخ بداية ونهاية صحيحين.');return}
    if(from>to){setError('تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساويًا له.');return}
    setBusy(true);setError('');setReport(null);setOpenError('');
    try{
      const params=new URLSearchParams({invoiceListFrom:from,invoiceListTo:to});
      const response=await fetch('/api/reconcile?'+params.toString(),{cache:'no-store'});
      const data=await response.json() as CollectedInvoiceResult&{error?:string};
      if(!response.ok)throw Error(data.error||'تعذّر جمع فواتير الفترة.');
      setReport(data);
    }catch(e){setError(e instanceof Error?e.message:'تعذّر جمع فواتير الفترة.')}
    finally{setBusy(false)}
  }

  async function openInvoice(row:Pick<CollectedInvoice,'recordId'|'invoiceId'>){
    const key=row.recordId+':'+row.invoiceId;
    setOpening(key);setOpenError('');
    try{await onOpenInvoice(row.recordId,row.invoiceId)}
    catch(e){setOpenError(e instanceof Error?e.message:'تعذّر فتح ترحيلات الفاتورة.')}
    finally{setOpening('')}
  }

  function exportExcel(){
    if(!report?.rows.length)return;
    const rows:(string|number)[][]=[
      ['رقم الفاتورة','الفرع','التاريخ','الترحيلات المرتبطة','المبلغ (د.أ)','ترحيلات المجموعة المعتمدة','ترحيلات تحتاج مراجعة','مصدر التاريخ'],
      ...report.rows.map(row=>[
        row.number,row.branch,row.date,row.transferNumbers.join('، '),row.amount,
        (row.groupConfirmedTransfers||[]).join('، '),row.unresolvedTransferNumbers.join('، '),
        row.dateSource==='transfer'?'تاريخ مشتق من ترحيل SAP':'محفوظ على الفاتورة'
      ]),
    ];
    const workbook=tableWorkbook(rows,'فواتير المؤسسة',[23,28,17,44,20,44,44,28]);
    const url=URL.createObjectURL(workbook),anchor=document.createElement('a');
    anchor.href=url;
    anchor.download='institution-invoices-'+report.from+'-to-'+report.to+'.xlsx';
    anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function exportUndatedExcel(){
    if(!report?.undatedDetails.length)return;
    const rows:(string|number)[][]=[
      ['رقم الفاتورة','الفرع','التاريخ الخام','تاريخ الكشف','الترحيلات المسجلة بالمجموعة','المبلغ (د.أ)','سبب نقص التاريخ'],
      ...report.undatedDetails.map(row=>[
        row.number,row.branch,row.originalDate,row.recordDate,row.transferNumbers.join('، '),row.amount,row.reason
      ]),
    ];
    const workbook=tableWorkbook(rows,'فواتير تحتاج تاريخ',[23,27,20,20,45,22,68]);
    const url=URL.createObjectURL(workbook),anchor=document.createElement('a');
    anchor.href=url;anchor.download='invoices-needing-dates-'+report.from+'-to-'+report.to+'.xlsx';
    anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  return <div className="audit-page">
    <div className="page-title"><div><p className="eyebrow">تجميع فواتير المؤسسة · قراءة فقط</p>
      <h1>جندي تدقيق أصناف المؤسسة — جمع الفواتير</h1>
      <p>يجمع رقم الفاتورة والفرع وتاريخها وترحيلاتها والمبلغ المحفوظ، بدون تعريف أصناف أو تدقيق كميات أو أسعار أو تعديل السجلات.</p>
    </div></div>
    <section className="panel">
      <div className="section-title"><CalendarDays size={20}/><h2>جمع الفواتير حسب الفترة</h2></div>
      <p className="hint">الفترة حسب تاريخ الفاتورة الزرقاء، وتشمل يوم البداية والنهاية. يتم جلب البيانات من السجلات المحفوظة فقط.</p>
      <div className="form-grid">
        <label>من تاريخ<input type="date" dir="ltr" value={dateFrom} max={dateTo}
          onChange={event=>{setDateFrom(event.target.value);setReport(null);setError('')}}/></label>
        <label>إلى تاريخ<input type="date" dir="ltr" value={dateTo} min={dateFrom}
          onChange={event=>{setDateTo(event.target.value);setReport(null);setError('')}}/></label>
        <div style={{alignSelf:'end'}}><button type="button" className="button primary" disabled={busy}
          onClick={()=>void collect()}><FileSearch size={16}/>{busy?'جاري جمع الفواتير…':'جمع فواتير الفترة'}</button></div>
      </div>
      {error&&<p className="banner danger" role="alert">{error}</p>}
      {report&&<div>
        <div className="section-title">
          <h2>نتيجة الفترة: {report.from} إلى {report.to} · {report.rows.length} فاتورة</h2>
          <button type="button" className="button secondary" disabled={!report.rows.length}
            onClick={exportExcel}><Download size={16}/>سحب كشف Excel</button>
        </div>
        {report.inferredDates>0&&<p className="banner info" role="status">
          استرجعت تاريخ {report.inferredDates} فاتورة في هذه الفترة من تاريخ ترحيل SAP المؤكد (قبل الترحيل بيوم)،
          دون تغيير تاريخها المحفوظ. ستجد مصدر التاريخ في كشف Excel.
        </p>}
        {report.unreadableRecords>0&&<p className="banner danger" role="alert">
          <AlertTriangle size={16}/> سجلات غير قابلة للقراءة: {report.unreadableRecords}.
        </p>}
        {report.undatedInvoices>0&&<details className="review-list no-print" open>
          <summary><AlertTriangle size={16}/> {report.undatedInvoices} فواتير بلا تاريخ يمكن التحقق منه — عرض الأرقام والأسباب</summary>
          <p className="hint">هذه الفواتير موجودة في السجل الكامل، وليس بالضرورة ضمن الفترة التي اخترتها.
            لم أحذفها أو أعطِها تاريخًا تخمينيًا؛ أرقامها معروضة لتقدر تفتح سجلها وتصوّب تاريخها.</p>
          <button type="button" className="button secondary" onClick={exportUndatedExcel}>سحب قائمة الفواتير الناقصة Excel</button>
          <div className="table-scroll"><table>
            <thead><tr><th>رقم الفاتورة</th><th>الفرع</th><th>تاريخ الفاتورة المحفوظ</th>
              <th>تاريخ الكشف</th><th>ترحيلات المجموعة</th><th>السبب</th><th>فتح</th></tr></thead>
            <tbody>{report.undatedDetails.map((row:UndatedInvoice)=>{
              const key=row.recordId+':'+row.invoiceId;
              return <tr key={key}><td><b>{row.number||'غير مدخل'}</b></td>
                <td>{row.branch||'—'}</td><td dir="ltr">{row.originalDate||'فارغ'}</td>
                <td dir="ltr">{row.recordDate||'—'}</td>
                <td>{row.transferNumbers.join('، ')||'—'}</td><td>{row.reason}</td>
                <td><button type="button" className="button secondary small" disabled={!!opening}
                  onClick={()=>void openInvoice(row)}><FolderOpen size={14}/>
                  {opening===key?'جاري الفتح…':'فتح السجل'}</button></td>
              </tr>;
            })}</tbody>
          </table></div>
          {report.undatedInvoices>report.undatedDetails.length&&<p className="hint">
            عُرض أول {report.undatedDetails.length} من الفواتير غير المؤرخة.
          </p>}
        </details>}
        {report.rows.length===0?<p className="hint">لا توجد فواتير محفوظة بتاريخ يقع ضمن الفترة المحددة.</p>:
          <div className="table-scroll"><table>
            <thead><tr><th>رقم الفاتورة</th><th>الفرع</th><th>التاريخ</th>
              <th>الترحيلات المرتبطة</th><th>المبلغ (د.أ)</th><th>فتح</th></tr></thead>
            <tbody>{report.rows.map(row=>{
              const key=row.recordId+':'+row.invoiceId;
              return <tr key={key}>
                <td><b>{row.number||'غير مدخل'}</b></td>
                <td>{row.branch||'غير محدد'}</td>
                <td dir="ltr">{row.date}
                  {row.dateSource==='transfer'&&<p className="hint">من تاريخ الترحيل</p>}
                </td>
                <td>{row.transferNumbers.join('، ')||'غير محددة'}
                  {(row.groupConfirmedTransfers||[]).length>0&&<p className="hint">
                    ترحيلات المجموعة المعتمدة: {row.groupConfirmedTransfers.join('، ')}
                  </p>}
                  {row.unresolvedTransferNumbers.length>0&&<p className="amber">
                    ترحيلات تحتاج مراجعة مستقلة: {row.unresolvedTransferNumbers.join('، ')}
                  </p>}</td>
                <td dir="ltr">{row.amount||'غير مدخل'}</td>
                <td><button type="button" className="button secondary small" disabled={!!opening}
                  onClick={()=>void openInvoice(row)}><FolderOpen size={14}/>
                  {opening===key?'جاري الفتح…':'فتح الترحيلات'}</button></td>
              </tr>;
            })}</tbody>
          </table></div>}
        {openError&&<p role="alert" className="banner danger">{openError}</p>}
        <p className="hint">ملف Excel يحتوي بيانات الفواتير المطلوبة، وترحيلات المجموعات القديمة المعتمدة تظهر كترحيلات مجموعة دون اشتراط أرقام الصفحات؛ ولا تُنسب كأنها تخص فاتورة منفردة.</p>
      </div>}
    </section>
  </div>;
}
