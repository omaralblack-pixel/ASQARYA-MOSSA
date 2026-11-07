'use client';

import {useMemo, useState} from 'react';
import {Download, RefreshCw, Search} from 'lucide-react';
import {dateValue, digits, fils, money, transferNumbers, type Draft} from '../lib/reconcile';

type RecordSummary = {id: string; branch: string; doc_date: string; payload: string};
const institution = 'المؤسسة الاستهلاكية العسكرية';
const headers = ['رقم الفاتورة', 'رقم الصفحة', 'أرقام ترحيلات المجموعة', 'اسم المؤسسة', 'الفرع', 'تاريخ الفاتورة', 'تاريخ المجموعة', 'مبلغ الفاتورة (د.أ)'];

function registerRows(records: RecordSummary[]) {
  return records.flatMap(record => {
    const group: Pick<Draft, 'transfers' | 'invoices'> = JSON.parse(record.payload);
    const transfers = new Map(group.transfers.flatMap(transfer => transferNumbers(transfer.number || '').map(number => [number, dateValue(transfer.date || '') || ''] as const)));
    return group.invoices.flatMap((invoice, index) => {
      if (!invoice.number?.trim()) return [];
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
  const rows = useMemo(() => registerRows(records), [records]);
  const visible = rows.filter(row => (!month || row.date.startsWith(month)) && digits(row.values.join(' ')).includes(digits(query.trim())));

  async function exportRegister() {
    const {invoiceWorkbook} = await import('../lib/invoice-workbook');
    const url = URL.createObjectURL(invoiceWorkbook([headers, ...visible.map(row => row.values)]));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'institution-invoices' + (month ? '-' + month : '') + '.xlsx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <div className="page-title">
      <div><p className="eyebrow">الأرشيف</p><h1>سجل فواتير المؤسسة</h1><p>كل فاتورة ورقية محفوظة بسطر مستقل مع الترحيلات المرتبطة بمجموعتها.</p></div>
      <button className="button secondary" disabled={busy} onClick={refresh}><RefreshCw size={16}/>تحديث</button>
    </div>
    <section className="panel">
      <div className="table-controls">
        <div className="search"><Search size={16}/><input aria-label="بحث في سجل الفواتير" value={query} onChange={e => setQuery(e.target.value)} placeholder="ابحث بالفرع أو رقم الفاتورة أو الترحيل"/></div>
        <label>شهر الفاتورة<input type="month" value={month} onChange={e => setMonth(e.target.value)}/></label>
        <button className="button secondary" disabled={!visible.length} onClick={exportRegister}><Download size={16}/>تصدير Excel</button>
      </div>
      <p className="hint">{visible.length} فاتورة · عند غياب تاريخ الفاتورة يُستخدم تاريخ المجموعة في فلتر الشهر.</p>
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
  </>;
}
