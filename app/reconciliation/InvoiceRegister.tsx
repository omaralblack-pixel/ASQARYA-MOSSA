'use client';

import {useMemo, useState} from 'react';
import {Download, RefreshCw, Search} from 'lucide-react';
import {dateValue, digits, fils, money, transferNumbers, type Draft} from '../lib/reconcile';

type RecordSummary = {id: string; branch: string; doc_date: string; payload: string};
const institution = 'المؤسسة الاستهلاكية العسكرية';
const headers = ['رقم الفاتورة', 'رقم الصفحة', 'أرقام ترحيلات المجموعة', 'اسم المؤسسة', 'الفرع', 'تاريخ الفاتورة', 'تاريخ المجموعة', 'مبلغ الفاتورة (د.أ)'];

function registerRows(records: RecordSummary[], status: 'received' | 'pending' = 'received') {
  return records.flatMap(record => {
    const group: Pick<Draft, 'transfers' | 'invoices'> & {summary?: {status?: string; acceptedDifference?: boolean}} = JSON.parse(record.payload);
    
    const transfers = new Map(group.transfers.flatMap(transfer => transferNumbers(transfer.number || '').map(number => [number, dateValue(transfer.date || '') || ''] as const)));
    return group.invoices.flatMap((invoice, index) => {
      if (!invoice.number?.trim() || (status === 'received' ? invoice.complete !== true : invoice.complete === true)) return [];
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
  const [pastedInvoices, setPastedInvoices] = useState('');
  const [comparisonText, setComparisonText] = useState('');
  const [status, setStatus] = useState<'received' | 'pending'>('received');
  const received = useMemo(() => registerRows(records, 'received'), [records]);
  const pending = useMemo(() => registerRows(records, 'pending'), [records]);
  const rows = status === 'received' ? received : pending;
  const selectedDate = dateValue(invoiceDate);
  const visible = rows.filter(row => (!month || row.date.startsWith(month)) && (!invoiceDate.trim() || (selectedDate !== null && row.values[5] === selectedDate)) && digits(row.values.join(' ')).includes(digits(query.trim())));
  const branchCount = new Set(visible.map(row => row.record.branch.trim()).filter(Boolean)).size;

  const comparison = useMemo(() => {
    const parsed: {line: number; number: string; raw: string; date: string; amount: string}[] = [];
    const unread: {line: number; raw: string}[] = [];
    comparisonText.split(/\r?\n/).forEach((raw, index) => {
      const text = digits(raw).trim();
      if (!text || /^[|\s:-]+$/.test(text)) return;
      const numbers = [...text.matchAll(/(?:^|[^\d])(\d{8,20})(?!\d)/g)].map(match => match[1]);
      if (numbers.length !== 1) {
        if (numbers.length || /\d/.test(text)) unread.push({line: index + 1, raw});
        return;
      }
      const dateMatch = text.match(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/);
      const amountMatch = text.slice(text.indexOf(numbers[0]) + numbers[0].length).match(/(?:^|[^\d])(\d[\d,]*\.\d{3})(?!\d)/);
      parsed.push({line: index + 1, number: numbers[0], raw, date: dateMatch ? dateValue(dateMatch[0]) || '' : '', amount: amountMatch?.[1] || ''});
    });
    const counts = new Map<string, number>();
    parsed.forEach(row => counts.set(row.number, (counts.get(row.number) || 0) + 1));
    const all = [...received.map(row => ({...row, received: true})), ...pending.map(row => ({...row, received: false}))];
    return {unread, rows: parsed.map(row => {
      const matches = all.filter(item => digits(item.values[0].trim()) === row.number);
      const saved = matches[0];
      const differentDate = !!(row.date && saved?.values[5] && row.date !== saved.values[5]);
      const differentAmount = !!(row.amount && saved?.values[7] && fils(row.amount) !== fils(saved.values[7]));
      const state = matches.length > 1 || (counts.get(row.number) || 0) > 1 || differentDate || differentAmount ? 'review' : !saved ? 'missing' : saved.received ? 'received' : 'pending';
      return {...row, state, saved, differentDate, differentAmount};
    })};
  }, [comparisonText, received, pending]);

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
      <h2>مقارنة كشف الفواتير الواصلة</h2>
      <p className="hint">ألصق الجدول من Excel أو النص؛ يفحص النظام رقم كل فاتورة مقابل جميع المجموعات المحفوظة، بغض النظر عن الفلاتر أدناه. حدّث السجل قبل المقارنة.</p>
      <label>كشف الفواتير<textarea aria-label="كشف الفواتير للمقارنة" rows={6} style={{width:'100%'}} value={pastedInvoices} onChange={e => setPastedInvoices(e.target.value)} placeholder={'1\t01-11-2026\t2624002303\tمجمع الجاردنز التجاري\t186.400'}/></label>
      <div><button type="button" className="button primary" disabled={busy || !pastedInvoices.trim()} onClick={() => setComparisonText(pastedInvoices)}>فحص الفواتير</button>{' '}<button type="button" className="button secondary" onClick={() => {setPastedInvoices(''); setComparisonText('')}}>مسح الكشف</button></div>
      {comparisonText && <>
        <p><strong>{comparison.rows.length} فاتورة مقروءة</strong> · واصلة: {comparison.rows.filter(row=>row.state==='received').length} · مسجلة وورقها غير مؤكد: {comparison.rows.filter(row=>row.state==='pending').length} · غير موجودة في السجل: {comparison.rows.filter(row=>row.state==='missing').length} · تحتاج مراجعة: {comparison.rows.filter(row=>row.state==='review').length}</p>
        <p className="hint">المطابقة برقم الفاتورة؛ قارن اسم الفرع في الكشف مع الفرع المحفوظ. اختلاف التاريخ أو المبلغ أو تكرار الرقم يظهر للمراجعة، ولا يغيّر أي بيانات.</p>
        {!!comparison.unread.length && <div role="alert"><strong>سطور لم تُقرأ، راجعها ({comparison.unread.length}):</strong>{comparison.unread.map(row=><p key={row.line}>سطر {row.line}: {row.raw}</p>)}</div>}
        <div className="table-scroll"><table><thead><tr><th>رقم الفاتورة</th><th>بيانات السطر الملصق</th><th>الحالة</th><th>الفرع المحفوظ</th><th>المجموعة</th></tr></thead><tbody>
          {comparison.rows.map(row=><tr key={row.line}><td dir="ltr">{row.number}</td><td>{row.raw}</td><td>{row.state==='received'?'واصلة':row.state==='pending'?'مسجلة وورقها غير مؤكد':row.state==='missing'?'غير موجودة في السجل':'تحتاج مراجعة'}{row.differentDate?' · التاريخ مختلف':''}{row.differentAmount?' · المبلغ مختلف':''}</td><td>{row.saved?.record.branch||'—'}</td><td>{row.saved && <button type="button" className="button secondary small" onClick={()=>open(row.saved!.record)}>فتح المجموعة</button>}</td></tr>)}
        </tbody></table></div>
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
      <p className="hint">{status === "received" ? "فواتير وصلتني وشيّكتها" : "فواتير لم يصل ورقها"} · <strong>{visible.length} فاتورة</strong> · <strong>{branchCount} فرع</strong> · العدد حسب التاريخ والبحث والفلاتر المختارة. البحث بيوم محدد يعتمد تاريخ الفاتورة نفسها. الإكسل مرتب من أقدم تاريخ لأحدث تاريخ؛ وعند غياب تاريخ الفاتورة يُستخدم تاريخ المجموعة للترتيب وفلتر الشهر.</p>
      <div className="table-scroll">
        <table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}<th>المجموعة</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.key}>
            {row.values.map((value, index) => <td key={index} dir={index < 3 || index >= 5 ? 'ltr' : undefined}>{value || '—'}</td>)}
            <td><button className="button secondary small" onClick={() => open(row.record)}>فتح المجموعة</button></td>
          </tr>)}</tbody>
        </table>
        {!visible.length && <div className="empty">لا توجد فواتير ضمن العرض الحالي.</div>}
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
