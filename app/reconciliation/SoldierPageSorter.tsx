'use client';
import {useMemo,useState} from 'react';
import {AlertTriangle,CheckCircle2} from 'lucide-react';
import {auditDraftWithSoldier} from '../lib/daily-soldier';
import {sortSoldierInvoicePages,type PageSortIssue} from '../lib/soldier-page-sort';
import {money,type Draft} from '../lib/reconcile';
import type {AuditCatalog} from '../lib/audit-catalog';

const close=(a:number,b:number)=>Math.abs(a-b)<0.000001;
/** Live preview of invoice-by-invoice classification. Only explicit Apply/Approve mutates the draft. */
export default function SoldierPageSorter({draft,catalog,onChange}:{
 draft:Draft;catalog:AuditCatalog|null;onChange:(draft:Draft)=>void;
}){
 const [inputs,setInputs]=useState<Record<string,Record<string,string>>>({});
 const [error,setError]=useState('');
 const proposed=useMemo(()=>catalog?sortSoldierInvoicePages(draft,catalog):null,[draft,catalog]);
 const check=useMemo(()=>proposed&&catalog?auditDraftWithSoldier(proposed.draft,catalog):null,[proposed,catalog]);
 if(!catalog)return <section className="panel no-print"><h2>فرز أصناف الجندي على صفحات الفواتير</h2>
   <p className="amber">مرجع الجندي غير متاح. لا يمكن توزيع الصفحات تلقائيًا بدون أصناف SAP المعرّفة.</p></section>;
 if(!proposed)return null;
 const total=proposed.lines.length;
 const confirmed=!!draft.soldierLineAllocations;
 const approve=(issue:PageSortIssue)=>{
   const values=inputs[issue.key]||{};
   const parsed=Object.entries(values).filter(([,value])=>value.trim()).map(([page,value])=>[page,Number(value)] as const);
   const total=parsed.reduce((s,[,qty])=>s+qty,0);
   if(!parsed.length||parsed.some(([page,qty])=>!issue.candidates.includes(Number(page))||
       !Number.isFinite(qty)||qty<=0)||!close(total,issue.totalPieces)){
     setError('راجع توزيع '+issue.sapCode+': لازم مجموع الحبات على الصفحات يساوي '+issue.totalPieces+
       ' حبة بالضبط، وبالصفحات اللي يظهر فيها الصنف على الفواتير.');
     return;
   }
   setError('');
   const next=proposed.draft;
   onChange({...next,soldierLineAllocations:{
     ...next.soldierLineAllocations,[issue.key]:Object.fromEntries(parsed)},
     soldierManualLineKeys:[...new Set([...(next.soldierManualLineKeys||[]),issue.key])],
   });
   setInputs(current=>{const updated={...current};delete updated[issue.key];return updated;});
 };
 return <section className="panel no-print" id="soldier-page-sort">
   <div className="section-title">
     <div><h2>الجندي — فرز الأصناف إلى صفحات الفواتير الزرقاء</h2>
       <p>يطابق أرقام المؤسسة والكميات بالحبة مع سطور SAP، ثم يحسب قيمة كل صفحة ويحفظ توزيع كل ترحيل.</p></div>
     <button type="button" className="button primary" onClick={()=>{
       onChange(proposed.draft);
       setError('');
     }}>فرز الأصناف وتطبيق الصفحات</button>
   </div>
   <p className="hint">{confirmed?'يوجد توزيع محفوظ في مسودة الفواتير. أي تعديل جديد يُحفظ عند الضغط على حفظ المجموعة.':
     'هذه معاينة؛ اضغط فرز الأصناف وتطبيق الصفحات، أو احفظ المجموعة ليثبّت السيرفر التوزيع المعتمد.'}</p>
   <p className="hint">سطور مُصنّفة: <b>{proposed.assigned}</b> · سطور موزعة على أكثر من صفحة: <b>{proposed.split}</b>
     {' '}· تحتاج تحديدًا: <b>{proposed.unresolved.length}</b></p>
   {draft.invoices.map((invoice,index)=>{
     const page=index+1,lines=proposed.lines.filter(line=>line.page===page);
     const groups=new Map<string,{code:string;name:string;pieces:number;price:number|null;value:number|null;transfers:Set<string>}>();
     for(const line of lines){
       const key=line.institutionCode;
       const old=groups.get(key);
       groups.set(key,{code:key,name:line.institutionName,
         pieces:(old?.pieces||0)+line.pieces,price:line.price,
         value:old?.value===null||line.value===null?null:(old?.value||0)+line.value,
         transfers:new Set([...(old?.transfers||[]),line.transferNumber])});
     }
     const status=check?.invoices[index];
     const total=groups.size&&[...groups.values()].every(row=>row.value!==null)
       ?[...groups.values()].reduce((s,row)=>s+row.value!,0):null;
     return <details key={invoice.id} open={index===0} className="review-list">
       <summary>الفاتورة {page} · {invoice.number||'بدون رقم'} · {lines.length} سطر موزع
         {' '}· {status?.status==='match'?'مطابق':status?.status==='difference'?'يوجد فرق':'بانتظار إكمال التدقيق'}</summary>
       <p className="hint">المبلغ الورقي: {invoice.amount||'غير مدخل'} د.أ
         {' '}· قيمة الأصناف المحسوبة: {total===null?'غير مكتملة':money(total)+' د.أ'}</p>
       {groups.size>0&&<div className="table-scroll"><table><thead><tr>
         <th>رقم المؤسسة</th><th>الصنف</th><th>صافي الحبات</th><th>سعر الحبة</th><th>القيمة</th><th>الترحيلات</th>
       </tr></thead><tbody>{[...groups.values()].map(row=><tr key={row.code}>
         <td>{row.code}</td><td>{row.name}</td><td>{Number(row.pieces.toFixed(6))}</td>
         <td>{row.price===null?'ناقص':money(row.price)}</td>
         <td>{row.value===null?'ناقص':money(row.value)}</td>
         <td>{[...row.transfers].join('، ')}</td>
       </tr>)}</tbody></table></div>}
       {status?.status!=='match'&&status?.reasons?.length>0&&<p className="amber">
         {status.reasons.slice(0,3).join(' · ')}</p>}
     </details>;
   })}
   {proposed.unresolved.length>0&&<details open className="review-list">
     <summary><AlertTriangle size={16}/> {proposed.unresolved.length} سطر يحتاج تحديد الصفحة أو توزيع الكمية</summary>
     <p className="hint">لن يرتبط أي سطر غير محسوم بفاتورة من تلقاء نفسه. إذا ظهر الصنف على أكثر من فاتورة،
       وزع عدد الحبات الفعلي لكل صفحة. ولا تغيّر كميات SAP الأصلية.</p>
     {proposed.unresolved.map(issue=><div key={issue.key} className="panel">
       <p><b>{issue.sapCode}</b> · ترحيل {issue.transfer} · {issue.totalPieces} حبة</p>
       <p className="amber">{issue.reason}</p>
       {issue.candidates.map(page=><label key={page}>عدد الحبات المخصصة لصفحة {page}
         {' '}({draft.invoices[page-1]?.number||'رقم الفاتورة غير مدخل'})
         <input type="number" min="0" step="any" inputMode="decimal"
           value={inputs[issue.key]?.[String(page)]??''}
           onChange={e=>setInputs(prev=>({...prev,[issue.key]:{
             ...(prev[issue.key]||{}),[String(page)]:e.target.value,
           }}))}/>
       </label>)}
       {issue.candidates.length>0&&<button type="button" className="button secondary"
         onClick={()=>approve(issue)}>اعتماد توزيع هذا السطر</button>}
     </div>)}
   </details>}
   {error&&<p role="alert" className="banner danger">{error}</p>}
   {!proposed.unresolved.length&&total>0&&<p className="hint">
     <CheckCircle2 size={15}/> كل سطور SAP التي يمكن تحويلها إلى حبات موزعة. تبقى مطابقة السعر والكمية والشروط الأخرى لكل فاتورة إلزامية.
   </p>}
 </section>;
}
