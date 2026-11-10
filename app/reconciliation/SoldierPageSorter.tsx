'use client';
import {useMemo,useState} from 'react';
import {AlertTriangle,CheckCircle2} from 'lucide-react';
import {sortSoldierInvoicePages,type PageSortIssue} from '../lib/soldier-page-sort';
import type {Draft} from '../lib/reconcile';
import type {AuditCatalog} from '../lib/audit-catalog';

const equal=(a:number,b:number)=>Math.abs(a-b)<0.000001;

/** Page sorter only: it never audits the accuracy or value of blue invoices. */
export default function SoldierPageSorter({draft,catalog,onChange}:{
  draft:Draft;catalog:AuditCatalog|null;onChange:(draft:Draft)=>void;
}){
  const [inputs,setInputs]=useState<Record<string,Record<string,string>>>({});
  const [error,setError]=useState('');
  const proposed=useMemo(()=>catalog?sortSoldierInvoicePages(draft,catalog):null,[draft,catalog]);
  if(!catalog||!proposed)return <section className="panel no-print">
    <h2>الجندي — فرز الأصناف على صفحات الفواتير</h2>
    <p className="amber">مرجع الأصناف المطلوب للفرز غير متاح. لا يمكن تحديد الصفحات تلقائيًا.</p>
  </section>;

  const confirmed=draft.soldierLineAllocations!==undefined;
  function approve(issue:PageSortIssue){
    if(!proposed)return;
    const parsed=Object.entries(inputs[issue.key]||{})
      .filter(([,value])=>value.trim()).map(([page,value])=>[page,Number(value)] as const);
    const total=parsed.reduce((sum,[,quantity])=>sum+quantity,0);
    if(!parsed.length||parsed.some(([page,quantity])=>!issue.candidates.includes(Number(page))||
        !Number.isFinite(quantity)||quantity<=0)||!equal(total,issue.totalPieces)){
      setError('مجموع الكمية الموزعة للصنف '+issue.sapCode+' يجب أن يساوي '+issue.totalPieces+
        ' حبة بالضبط، على الصفحات التي تحتوي هذا الصنف.');
      return;
    }
    const next=proposed.draft;
    onChange({...next,soldierLineAllocations:{
      ...next.soldierLineAllocations,[issue.key]:Object.fromEntries(parsed)},
      soldierManualLineKeys:[...new Set([...(next.soldierManualLineKeys||[]),issue.key])],
    });
    setError('');
    setInputs(current=>{const out={...current};delete out[issue.key];return out});
  }

  return <section className="panel no-print" id="soldier-page-sort">
    <div className="section-title"><div>
      <h2>الجندي — فرز الأصناف إلى صفحات الفواتير الزرقاء</h2>
      <p>يحدد الصفحة المطلوبة لكل سطر من ترحيلات SAP. لا يطابق الأسعار ولا يعتمد صحة الفاتورة.</p>
    </div>
    <button type="button" className="button primary" onClick={()=>{
      onChange(proposed.draft);setError('');
    }}>فرز الأصناف وتطبيق الصفحات</button></div>
    <p className="hint">{confirmed?
      'يوجد توزيع محفوظ في المسودة. يُحفظ أي تعديل جديد مع حفظ المجموعة.':
      'هذه معاينة؛ اضغط تطبيق الصفحات أو احفظ المجموعة لتثبيت الفرز.'}</p>
    <p className="hint">سطور موزعة: <b>{proposed.assigned}</b> · سطور مقسّمة بين صفحات: <b>{proposed.split}</b>
      {' '}· سطور بحاجة لتحديد: <b>{proposed.unresolved.length}</b></p>
    {draft.invoices.map((invoice,index)=>{
      const page=index+1;
      const lines=proposed.lines.filter(line=>line.page===page);
      const groups=new Map<string,{code:string;name:string;pieces:number;transfers:Set<string>}>();
      for(const line of lines){
        const previous=groups.get(line.institutionCode);
        groups.set(line.institutionCode,{
          code:line.institutionCode,name:line.institutionName,
          pieces:(previous?.pieces||0)+line.pieces,
          transfers:new Set([...(previous?.transfers||[]),line.transferNumber]),
        });
      }
      return <details key={invoice.id} open={index===0} className="review-list">
        <summary>الفاتورة {page} · {invoice.number||'بدون رقم'} · {lines.length} سطر موزع</summary>
        {groups.size>0&&<div className="table-scroll"><table><thead><tr>
          <th>رقم المؤسسة</th><th>الصنف</th><th>صافي الحبات</th><th>الترحيلات</th>
        </tr></thead><tbody>{[...groups.values()].map(row=><tr key={row.code}>
          <td>{row.code}</td><td>{row.name}</td><td>{Number(row.pieces.toFixed(6))}</td>
          <td>{[...row.transfers].join('، ')}</td>
        </tr>)}</tbody></table></div>}
      </details>;
    })}
    {proposed.unresolved.length>0&&<details open className="review-list">
      <summary><AlertTriangle size={16}/>{proposed.unresolved.length} سطر يحتاج تحديد الصفحة أو توزيع الكمية</summary>
      <p className="hint">لن تُنسب السطور غير المحسومة لفاتورة تلقائيًا. اختر صفحة كل سطر، وقسّم الكمية فقط عندما يرد الصنف على أكثر من فاتورة.</p>
      {proposed.unresolved.map(issue=><div key={issue.key} className="panel">
        <p><b>{issue.sapCode}</b> · ترحيل {issue.transfer} · {issue.totalPieces} حبة</p>
        <p className="amber">{issue.reason}</p>
        {issue.candidates.map(page=><label key={page}>كمية الحبات لصفحة {page}
          {' '}({draft.invoices[page-1]?.number||'رقم الفاتورة غير مدخل'})
          <input type="number" min="0" step="any" inputMode="decimal"
            value={inputs[issue.key]?.[String(page)]??''}
            onChange={event=>setInputs(current=>({...current,[issue.key]:{
              ...(current[issue.key]||{}),[String(page)]:event.target.value,
            }}))}/></label>)}
        {issue.candidates.length>0&&<button type="button" className="button secondary"
          onClick={()=>approve(issue)}>اعتماد توزيع هذا السطر</button>}
      </div>)}
    </details>}
    {error&&<p role="alert" className="banner danger">{error}</p>}
    {!proposed.unresolved.length&&proposed.lines.length>0&&<p className="hint">
      <CheckCircle2 size={15}/> تم فرز السطور القابلة للتوزيع. الفرز ليس اعتمادًا لصحة الفواتير أو الكميات أو الأسعار.
    </p>}
  </section>;
}
