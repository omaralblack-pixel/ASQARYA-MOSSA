'use client';

import {useEffect, useMemo, useState} from 'react';
import {Download, RefreshCw, Search} from 'lucide-react';
import {dateValue, digits, fils, invoiceDocumentNo, money, readReconciliationRecord, transferNumbers, type Draft} from '../lib/reconcile';
import {readSavedSapImport} from '../lib/saved-sap-import';
import {sapInvoicesFromSavedFile,compareSapWithSavedInvoices,type SapRegisterSource} from '../lib/sap-invoice-register';

type RecordSummary = {id: string; branch: string; doc_date: string; payload: string};
const institution = 'المؤسسة الاستهلاكية العسكرية';
const headers = ['رقم الفاتورة', 'رقم الصفحة', 'أرقام ترحيلات المجموعة', 'اسم المؤسسة', 'الفرع', 'تاريخ الفاتورة', 'تاريخ المجموعة', 'مبلغ الفاتورة (د.أ)'];

function registerRows(records: RecordSummary[], status: 'received' | 'pending' = 'received') {
  return records.flatMap(record => {
    const group=readReconciliationRecord(record.payload);
    if(!group)return [];
    
    const transfers = new Map(group.transfers.flatMap(transfer => transferNumbers(transfer.number || '').map(number => [number, dateValue(transfer.date || '') || ''] as const)));
    return group.invoices.flatMap((invoice, index) => {
      if (!invoiceDocumentNo(invoice.number) || (status === 'received' ? invoice.complete !== true : invoice.complete === true)) return [];
      const date = dateValue(invoice.date || '') || '';
      const groupDate = dateValue(record.doc_date || '') || '';
      const amount = fils(invoice.amount || '');
      const values = [invoice.number, String(index + 1), [...transfers.keys()].join(' + '), institution, record.branch, date, groupDate, amount === null ? '' : money(amount)];
      return [{key: record.id + ':' + index, record, date: date || groupDate, values, transfers}];
    });
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export function InvoiceRegisterPrint({records}: {records: RecordSummary[]}) {
  const rows = registerRows(records);
  return <section className="invoice-register-print">
    <h1>سجل المطابقات · الفواتير الزرقاء</h1>
    <p>{institution} · {rows.length} فاتورة</p>
    <table>
      <thead><tr><th>رقم الفاتورة الزرقاء</th><th>تاريخ الفاتورة</th><th>أرقام ترحيلات المجموعة وتواريخها</th><th>مبلغ الفاتورة (د.أ)</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.key}>
        <td dir="ltr">{row.values[0]}</td>
        <td dir="ltr">{row.values[5]||'—'}</td>
        <td>{[...row.transfers].map(([number,date])=><div key={number} dir="ltr">{number} — {date||'—'}</div>)}</td>
        <td dir="ltr">{row.values[7]||'—'}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}

export default function InvoiceRegister({records, busy, refresh, open}: {
  records: RecordSummary[];
  busy: boolean;
  refresh: () => void;
  open: (record: RecordSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [sapSource, setSapSource] = useState<SapRegisterSource | null>(null);
  const [sapName, setSapName] = useState('');
  const [sapError, setSapError] = useState('');
  const [sapBusy, setSapBusy] = useState(true);
  const [sapCheckedAt, setSapCheckedAt] = useState('');
  const [sapReload, setSapReload] = useState(0);
  const [sapFilter, setSapFilter] = useState<'all'|'notReceived'|'received'|'review'>('notReceived');
  const [status, setStatus] = useState<'received' | 'pending'>('received');
  const received = useMemo(() => registerRows(records, 'received'), [records]);
  const pending = useMemo(() => registerRows(records, 'pending'), [records]);
  // An invoice-number search must check every saved group regardless of the
  // currently selected paper status or date filter. Otherwise an existing
  // checked invoice can misleadingly appear to be absent.
  const searched = digits(query.trim()).toLowerCase();
  const searching = Boolean(query.trim());
  const exactInvoiceSearch = /^\d{8,20}$/.test(searched);
  const rows = searching ? [...received, ...pending] : status === 'received' ? received : pending;
  const receivedKeys = new Set(received.map(row => row.key));
  const selectedDate = dateValue(invoiceDate);
  const visible = rows.filter(row => {
    if (searching) {
      if (exactInvoiceSearch) return invoiceDocumentNo(row.values[0]) === searched;
      return digits(row.values.join(' ')).toLowerCase().includes(searched);
    }
    return (!month || row.date.startsWith(month)) &&
      (!invoiceDate.trim() || (selectedDate !== null && row.values[5] === selectedDate));
  });
  const branchCount = new Set(visible.map(row => row.record.branch.trim()).filter(Boolean)).size;

  // Re-open the stored SAP source whenever this screen mounts or the user requests a refresh.
  // Nothing is posted back to either SAP storage or the reconciliation database.
  useEffect(() => {
    let active = true;
    setSapBusy(true);
    setSapError('');
    readSavedSapImport().then(file => {
      if (!active) return;
      if (!file?.text?.trim()) {
        setSapSource(null);
        setSapName('');
        setSapError('لا يوجد كشف SAP محفوظ. ارفع كشف SAP من شاشة الاستيراد أولًا.');
        return;
      }
      const parsed = sapInvoicesFromSavedFile(file.text);
      setSapSource(parsed);
      setSapName(file.name || 'كشف SAP المحفوظ');
      setSapCheckedAt(new Date().toLocaleString('ar-JO'));
    }).catch(error => {
      if (active) {
        setSapSource(null);
        setSapError(error instanceof Error ? error.message : 'تعذّر قراءة كشف SAP المحفوظ.');
      }
    }).finally(() => {if (active) setSapBusy(false);});
    return () => {active = false;};
  }, [sapReload]);

  const comparison = useMemo(() => sapSource ? compareSapWithSavedInvoices(sapSource, records) : [], [sapSource,records]);
  const notReceived = comparison.filter(row=>row.state==='missing'||row.state==='pending');
  const questionable = comparison.filter(row=>row.state==='review');
  const visibleComparison = comparison.filter(row=>
    (exactInvoiceSearch||sapFilter==='all'||(sapFilter==='notReceived'&&(row.state==='missing'||row.state==='pending'))||row.state===sapFilter) &&
    (!exactInvoiceSearch || row.number===searched));
  const sapOnlySearchMatch = exactInvoiceSearch && !visible.length
    ? comparison.find(row=>row.number===searched && row.state==='missing') : undefined;
  async function exportSapPending(){
    const {invoiceWorkbook} = await import('../lib/invoice-workbook');
    const data = [
      ['رقم الفاتورة','حالة الورق','تاريخ SAP','الفرع في SAP','أرقام ترحيلات SAP','الفرع المحفوظ','مبلغ عمر','ملاحظة'],
      ...comparison.filter(row=>row.state!=='received').map(row=>[
        row.number,
        row.state==='pending'?'مسجلة والورق غير مؤكد':row.state==='missing'?'غير مسجلة — ورق غير مؤكد':'تحتاج مراجعة',
        row.dates.join('، '),row.branches.join('، '),row.transfers.join(' + '),
        row.record?.branch||'',row.savedAmount,row.reason,
      ]),
    ];
    const url=URL.createObjectURL(invoiceWorkbook(data));
    const link=document.createElement('a');link.href=url;link.download='sap-invoices-unconfirmed.xlsx';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  async function exportRegister() {
    const {invoiceWorkbook} = await import('../lib/invoice-workbook');
    const exportRows = [...visible].sort((a, b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99'));
    const url = URL.createObjectURL(invoiceWorkbook([headers, ...exportRows.map(row => row.values)]));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'institution-invoices' + (month ? '-' + month : '') + '.xlsx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <div className="page-title">
      <div><p className="eyebrow">الأرشيف</p><h1>سجل فواتير المؤسسة</h1><p>الفواتير التي أكدت وصول ورقها منفصلة عن الفواتير التي لم يصل ورقها.</p></div>
      <button className="button secondary" disabled={busy} onClick={refresh}><RefreshCw size={16}/>تحديث</button>
    </div>
    <section className="panel no-print">
      <h2>مقارنة فواتير كشف SAP المحفوظ مع الورق الواصل</h2>
      <p className="hint">هذه ميزة ثابتة: تُقرأ أرقام الفواتير من Remarks لنفس ملف SAP المحفوظ في شاشة الاستيراد، وتُقارن مع جميع المجموعات المحفوظة دون التقيد بفلاتر السجل. لا حاجة للصق كشف جديد، ولا تُغيّر علامة وصول الورق تلقائيًا.</p>
      <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
        <button type="button" className="button primary" disabled={busy||sapBusy} onClick={()=>{refresh();setSapReload(value=>value+1);}}><RefreshCw size={16}/>فحص الفواتير من SAP المحفوظ</button>
        <button type="button" className="button secondary" disabled={!comparison.some(row=>row.state!=='received')||sapBusy} onClick={()=>void exportSapPending()}><Download size={16}/>Excel للفواتير غير المؤكدة والمراجعة</button>
      </div>
      {sapBusy&&<p role="status">جارٍ قراءة كشف SAP المحفوظ ومقارنته بالسجل…</p>}
      {sapError&&<p role="alert" className="amber">{sapError}</p>}
      {sapOnlySearchMatch&&<p role="status" className="amber">الفاتورة {sapOnlySearchMatch.number} موجودة في Remarks بملف SAP، لكنها غير موجودة في سجلات المطابقة المحفوظة. أرقام ترحيلاتها: {sapOnlySearchMatch.transfers.join('، ')}. لا تعتبرها غير واصلة ورقيًا بناءً على SAP وحده.</p>}
      {sapSource&&!sapBusy&&<>
        <p className="hint">المصدر: <strong>{sapName}</strong> · آخر فحص: {sapCheckedAt} · {sapSource.sourceRows} سطر SAP · {sapSource.transferCount} ترحيل يحمل رقم فاتورة مقروءًا · {sapSource.ignoredCount} ترحيل خارج مسار الفواتير أو ملغى.</p>
        <div className="stats">
          <div className="stat"><span>فواتير SAP المقروءة</span><strong>{comparison.length}</strong></div>
          <div className="stat"><span>ورقها مؤكد عندك</span><strong>{comparison.filter(row=>row.state==='received').length}</strong></div>
          <div className="stat"><span>لسه مش مؤكدة الوصول</span><strong>{notReceived.length}</strong></div>
          <div className="stat"><span>بحاجة مراجعة</span><strong>{questionable.length}</strong></div>
        </div>
        <p className="hint">«لسه مش مؤكدة الوصول» تشمل الفواتير الموجودة في SAP وغير المسجلة في المجموعات، والمسجلة دون علامة «الفاتورة الورقية موجودة لدي». لا يُستنتج وصول الورق من SAP وحده. البيانات المسجلة يدويًا عندك هي المرجع.</p>
        {(sapSource.issues.length>0||sapSource.withoutInvoice.length>0)&&<details className="review-list" style={{marginTop:12}}>
          <summary>ملاحظات قراءة SAP — {sapSource.issues.length} تنبيه، {sapSource.withoutInvoice.length} ترحيل دون رقم فاتورة واضح</summary>
          <div style={{maxHeight:200,overflowY:'auto'}}>
            {sapSource.issues.map((issue,i)=><p key={'issue-'+i}>{issue}</p>)}
            {sapSource.withoutInvoice.map(number=><p key={'unread-'+number}>الترحيل {number}: لم يُستخرج رقم فاتورة من Remarks، فلا يجوز اعتباره ورقه واصلًا أو غير واصل.</p>)}
          </div>
        </details>}
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:16}}>
          <button type="button" className={'button '+(sapFilter==='notReceived'?'primary':'secondary')} onClick={()=>setSapFilter('notReceived')}>لسه مش مؤكدة ({notReceived.length})</button>
          <button type="button" className={'button '+(sapFilter==='received'?'primary':'secondary')} onClick={()=>setSapFilter('received')}>ورقها واصل ({comparison.filter(row=>row.state==='received').length})</button>
          <button type="button" className={'button '+(sapFilter==='review'?'primary':'secondary')} onClick={()=>setSapFilter('review')}>مراجعة ({questionable.length})</button>
          <button type="button" className={'button '+(sapFilter==='all'?'primary':'secondary')} onClick={()=>setSapFilter('all')}>كل فواتير SAP ({comparison.length})</button>
        </div>
        <div className="table-scroll"><table>
          <thead><tr><th>رقم الفاتورة</th><th>تاريخ SAP</th><th>الفرع SAP</th><th>ترحيلات SAP</th><th>حالة الورق</th><th>الملاحظة</th><th>المجموعة المحفوظة</th></tr></thead>
          <tbody>{visibleComparison.map(row=><tr key={row.number} style={{backgroundColor:row.state==='received'?'#d8f3dc':row.state==='review'?'#fff0bf':'#fad5e5'}}>
            <td dir="ltr">{row.number}</td>
            <td dir="ltr">{row.dates.join('، ')||'—'}</td>
            <td>{row.branches.join('، ')||'—'}</td>
            <td dir="ltr">{row.transfers.join('، ')}</td>
            <td>{row.state==='received'?'واصل ومؤكد':row.state==='pending'?'مسجلة — ورق غير مؤكد':row.state==='missing'?'غير مسجلة — ورق غير مؤكد':'تحتاج مراجعة'}</td>
            <td>{row.reason}</td>
            <td>{row.record?<button type="button" className="button secondary small" onClick={()=>open(row.record!)}>فتح المجموعة</button>:'—'}</td>
          </tr>)}</tbody>
        </table>{!visibleComparison.length&&<p className="hint">لا توجد فواتير ضمن حالة العرض هذه.</p>}</div>
      </>}
    </section>
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 210px",gap:16,alignItems:"start"}}>
    <section className="panel" style={{minWidth:0}}>
      <div className="table-controls">
        <div className="search"><Search size={16}/><input aria-label="البحث برقم الفاتورة أو الفرع أو الترحيل" value={query} onChange={e => setQuery(e.target.value)} placeholder="اكتب رقم الفاتورة للتأكد من وصولها، أو ابحث بالفرع أو الترحيل"/></div>
        <label>تاريخ الفاتورة<input type="text" inputMode="numeric" dir="ltr" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} placeholder="1.11.2026" aria-label="تاريخ الفاتورة المحدد"/></label>
        <label>شهر الفاتورة<input type="month" value={month} onChange={e => setMonth(e.target.value)}/></label>
        <button className="button secondary" disabled={status !== "received" || !visible.length} onClick={exportRegister}><Download size={16}/>تصدير Excel</button>
      </div>
      {invoiceDate.trim() && !selectedDate && <p role="alert">أدخل تاريخًا صحيحًا مثل 1.11.2026.</p>}
      <p className="hint">{searching ? 'نتائج البحث في كل السجلات والحالات والتواريخ (دون إخفاء الورق غير المؤكد)' : status === "received" ? "فواتير وصلتني وشيّكتها" : "فواتير لم يصل ورقها"} · <strong>{visible.length} فاتورة</strong> · <strong>{branchCount} فرع</strong> · العدد حسب التاريخ والبحث والفلاتر المختارة. البحث بيوم محدد يعتمد تاريخ الفاتورة نفسها. الإكسل مرتب من أقدم تاريخ لأحدث تاريخ؛ وعند غياب تاريخ الفاتورة يُستخدم تاريخ المجموعة للترتيب وفلتر الشهر.</p>
      <div className="table-scroll">
        <table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}{searching&&<th>حالة الورق</th>}<th>المجموعة</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.key}>
            {row.values.map((value, index) => <td key={index} dir={index < 3 || index >= 5 ? 'ltr' : undefined}>{value || '—'}</td>)}
            {searching&&<td>{receivedKeys.has(row.key)?'الورق مؤكد في السجل':'الورق غير مؤكد في السجل'}</td>}
            <td><button className="button secondary small" onClick={() => open(row.record)}>فتح المجموعة</button></td>
          </tr>)}</tbody>
        </table>
        {!visible.length && <div className="empty">{searching?'رقم الفاتورة غير موجود في سجلات المطابقة المحمّلة. راجع نتائج SAP أعلاه؛ وجوده في SAP وحده لا يثبت حفظ الفاتورة بالمشروع.':'لا توجد فواتير ضمن العرض الحالي.'}</div>}
      </div>
    </section>
    <aside className="panel" style={{position:"sticky",top:12,padding:12,display:"grid",gap:10}} aria-label="حالة وصول الفواتير">
      <strong>حالة الفواتير</strong>
      <button type="button" className={"button "+(status==="received"?"primary":"secondary")} onClick={()=>setStatus("received")}>واصلاني · شيّكتهم ({received.length})</button>
      <button type="button" className={"button "+(status==="pending"?"primary":"secondary")} onClick={()=>setStatus("pending")}>لسه مو واصلاني ({pending.length})</button>
      <p className="hint">التصنيف حسب خيار «الفاتورة الورقية موجودة لدي» داخل المجموعة. تصدير Excel للفواتير الواصلة فقط.</p>
    </aside>
    </div>
  </>;
}
