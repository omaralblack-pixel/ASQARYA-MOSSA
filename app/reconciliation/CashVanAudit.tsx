'use client';

import {useMemo,useState} from 'react';
import {cashVanMovementReport} from '../lib/lieutenant-counterparts';
import type {LieutenantTransfer} from '../lib/lieutenant';

const localDay=()=>{
  const now=new Date();
  return now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
};

export default function CashVanAudit({transfers,sourceName}:{transfers:LieutenantTransfer[];sourceName:string}){
  const [from,setFrom]=useState(()=>localDay().slice(0,8)+'01');
  const [to,setTo]=useState(localDay);
  const valid=!!from&&!!to&&from<=to&&to<=localDay();
  const rows=useMemo(()=>valid?cashVanMovementReport(transfers,from,to):[],[transfers,from,to,valid]);
  const latest=useMemo(()=>transfers.map(row=>row.transfer.date).filter(Boolean).sort().at(-1)||'',[transfers]);
  const settled=rows.filter(row=>['reversed','sap-canceled'].includes(row.movement.kind)&&!row.source.issues.length).length;
  return <section className="panel" aria-label="كاش فان — جميع الخطوط والعكسي والإلغاء">
    <div className="section-title"><div>
      <h2>كاش فان — جميع الخطوط والعكسي والإلغاء</h2>
      <p>فحص كامل الفترة من ملاحظات SAP، بما فيها Remarks وJournal Remarks. يظهر كل ترحيل مستقلًا باتجاه مستودعه، سواء كان محفوظًا أو مسوّى أو بلا فاتورة.</p>
    </div></div>
    <div className="table-controls no-print">
      <label>كاش فان — من تاريخ<input type="date" value={from} max={localDay()} onChange={event=>setFrom(event.target.value)}/></label>
      <label>كاش فان — حتى تاريخ<input type="date" value={to} max={localDay()} onChange={event=>setTo(event.target.value)}/></label>
    </div>
    {!valid&&<p className="banner warn" role="alert">اختر فترة صحيحة تنتهي اليوم أو قبله.</p>}
    <p className="hint">حسب تاريخ مستند SAP. هذا الفحص مستقل عن يوم الفاتورة الزرقاء وتاريخ لقطة رصيد المستودع، ويعرض جميع النتائج دون إخفاء المسوّى أو الاكتفاء بأول 50 ترحيلًا.</p>
    {transfers.length>0?<>
      <p className="hint">المصدر: <b dir="auto">{sourceName||'كشف SAP المحمّل'}</b> · أحدث تاريخ حركة في الكشف: <b dir="ltr">{latest}</b>.</p>
      {valid&&latest&&latest<to&&<p className="banner warn" role="status">الكشف المحفوظ يصل إلى {latest}؛ لا يغطي الحركات الأحدث حتى {to}. عدم ظهور عكسي أو إلغاء يعني أنه غير مثبت في هذا الكشف.</p>}
      <p role="status"><b>{rows.length}</b> ترحيلات كاش فان · <b>{settled}</b> مسوّاة · <b>{rows.length-settled}</b> تحتاج متابعة.</p>
      {!!rows.length&&<div className="table-scroll"><table>
        <thead><tr><th>رقم الترحيل</th><th>التاريخ</th><th>الخط من الملاحظات</th><th>اتجاه الترحيل</th><th>تسوية العكسي</th><th>حالة الإلغاء</th><th>المستند المقابل وتاريخه واتجاهه</th><th>الملاحظات والأصناف</th></tr></thead>
        <tbody>{rows.map(row=>{
          const {source,movement}=row;
          const complete=['reversed','sap-canceled'].includes(movement.kind)&&!source.issues.length;
          return <tr key={source.transfer.number}>
            <td dir="ltr"><b>{source.transfer.number}</b></td>
            <td dir="ltr">{source.transfer.date}</td>
            <td>{row.route}</td><td dir="ltr">{row.directions.join('، ')}</td>
            <td><span className={'badge '+(complete?'match':'review')}>
              {source.issues.length?'بيانات تحتاج مراجعة':movement.kind==='reversed'?'عكسي مطابق بالكامل':
                movement.kind==='sap-canceled'?'مسوّى بإلغاء SAP':'لم يثبت عكسي كامل'}
              </span><small style={{display:'block'}}>{movement.note}</small>
              {!!source.issues.length&&<p className="red">{source.issues.join(' · ')}</p>}
            </td>
            <td>{row.cancellationStatus}</td>
            <td>{row.counterparts.length?row.counterparts.map(doc=><div key={doc.number}>
              <b dir="ltr">{doc.number}</b><small dir="ltr" style={{display:'block'}}>{doc.date} · {doc.directions.join('، ')}</small>
            </div>):'لا يوجد مستند مقابل مثبت في الكشف'}</td>
            <td><details><summary>Remarks والأصناف ({source.lineCount})</summary>
              <p dir="auto" style={{whiteSpace:'pre-wrap'}}>{source.remarks||'لا توجد ملاحظات'}</p>
              <div className="table-scroll"><table><thead><tr><th>كود SAP</th><th>الصنف</th><th>الكمية</th><th>الوحدة</th></tr></thead>
                <tbody>{source.transfer.paste.split('\n').slice(1).filter(Boolean).map((line,index)=>{
                  const [code,name,qty,unit]=line.split('\t');
                  return <tr key={index}><td dir="ltr">{code}</td><td>{name}</td><td dir="ltr">{qty}</td><td>{unit}</td></tr>;
                })}</tbody></table></div>
            </details></td>
          </tr>;
        })}</tbody>
      </table></div>}
      {valid&&!rows.length&&<p>لم يُعثر على ترحيلات تحمل وصف كاش فان في ملاحظات الكشف ضمن الفترة المختارة.</p>}
      <p className="hint">العكسي من 011 إلى 001 يُراجع مقابل وارد 001 فقط، وإلى 002 مقابل وارد 002 فقط، مع تطابق جميع الأكواد والكميات والوحدات. لا يُعدّ العكسي إلغاءً رسميًا. عند غياب CANCELED تبقى حالة الإلغاء غير مثبتة.</p>
    </>:<p className="hint">بانتظار قراءة كشف ترحيلات SAP المحفوظ.</p>}
  </section>;
}
