'use client';

import {useMemo, useState} from 'react';
import {AlertTriangle, CheckCircle2, Save, Search, ClipboardPaste} from 'lucide-react';
import {digits, sapReferences, type Item} from '../lib/reconcile';
import {applyReplacements, parseReplacementText, previewReplacements, type ReplacementInput} from '../lib/catalog-replacement';

const empty={institutionCode:'',institutionName:'',sapCode:'',sapName:'',cartonPieces:'',sapUnit:'',kgPerPiece:''};
export default function CatalogReplacement({reference,onSaved}:{reference:Item[];onSaved:(items:Item[])=>void}){
  const [paste,setPaste]=useState('');
  const [manual,setManual]=useState({...empty});
  const [selected,setSelected]=useState<number[]>([]);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [query,setQuery]=useState('');
  const parsed=useMemo(()=>parseReplacementText(paste),[paste]);
  const extra=useMemo<ReplacementInput[]>(()=>{
    if(!manual.institutionCode.trim()&&!manual.sapCode.trim())return [];
    const errors:string[]=[];
    const institutionCode=digits(manual.institutionCode).trim();
    const sapCode=manual.sapCode.toUpperCase().trim();
    if(!/^\d{8}$/.test(institutionCode))errors.push('أدخل رقم المادة بالمؤسسة من 8 أرقام');
    if(!/^[A-Z]{2,6}\d{3,10}$/.test(sapCode))errors.push('أدخل كود SAP الصحيح');
    const count=manual.cartonPieces.trim()?Number(manual.cartonPieces):null;
    if(count!==null&&(!Number.isInteger(count)||count<=0))errors.push('عدد الحبات يجب أن يكون رقمًا صحيحًا موجبًا');
    const weight=manual.kgPerPiece.trim()?Number(manual.kgPerPiece):null;
    if(weight!==null&&(!Number.isFinite(weight)||weight<=0))errors.push('وزن الحبة غير صالح');
    const validUnit=['Piece','Carton','KG'].includes(manual.sapUnit);
    return [{line:1000000,institutionCode,institutionName:manual.institutionName,sapCode,
      sapName:manual.sapName,cartonPieces:count,sapUnit:validUnit?manual.sapUnit as 'Piece'|'Carton'|'KG':null,
      kgPerPiece:weight,errors}];
  },[manual]);
  const rows=useMemo(()=>previewReplacements([...parsed.rows,...extra],reference),[parsed.rows,extra,reference]);
  const shown=rows.filter(row=>!query.trim()||[
    row.institutionCode,row.targetCode,row.current?.name,row.sapCode,row.sapName,row.current?.warehouseName
  ].some(value=>String(value||'').toLowerCase().includes(query.trim().toLowerCase())));
  const ready=rows.filter(row=>row.status==='ready');
  const selectedCount=selected.filter(id=>ready.some(row=>row.line===id)).length;
  const current=reference.find(item=>item.code===digits(manual.institutionCode).trim());
  const liveCode=manual.sapCode.toUpperCase().trim();
  const existingSap=sapReferences(reference).find(item=>item.sapCode===liveCode);
  const input=(key:keyof typeof empty,value:string)=>setManual(state=>({...state,[key]:value}));

  async function save(){
    const accepted=rows.filter(row=>selected.includes(row.line));
    if(!accepted.length){setError('حدد التعديلات الجاهزة قبل الحفظ.');return}
    setBusy(true);setError('');setNotice('');
    try {
      const freshResponse=await fetch('/api/reconcile',{cache:'no-store'});
      const freshData=await freshResponse.json() as {error?:string;reference?:Item[]};
      if(!freshResponse.ok)throw Error(freshData.error||'تعذر تحديث المرجع');
      if(!Array.isArray(freshData.reference))throw Error('استجابة مرجع الأصناف غير صالحة. أعد تحميل الصفحة.');
      if(JSON.stringify(freshData.reference)!==JSON.stringify(reference)){
        onSaved(freshData.reference);
        setSelected([]);
        throw Error('تغيّر مرجع الأصناف في جلسة أخرى. تم تحميل المرجع الجديد؛ راجع التعديلات مرة ثانية.');
      }
      const items=applyReplacements(reference,rows,selected);
      const response=await fetch('/api/reconcile',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'reference',items})});
      const data=await response.json() as {error?:string;reference?:Item[]};
      if(!response.ok)throw Error(data.error||'تعذر حفظ تعريفات الأصناف');
      onSaved(data.reference||items);
      setSelected([]);
      setPaste('');
      setManual({...empty});
      setNotice('تم حفظ التعديلات المختارة في مرجع المؤسسة. أرقام المواد وأسماؤها وأسعارها لم تتغير. المطابقات السابقة لم تُعدّل.');
    }catch(e){setError(e instanceof Error?e.message:'تعذّر استبدال الأصناف');}
    finally{setBusy(false)}
  }
  return <div dir="rtl">
    <div className="page-title"><div>
      <p className="eyebrow">مرجع الأصناف · تحديث آمن</p><h1>استبدال الأصناف والشدّات</h1>
      <p>رقم المادة واسمها بالمؤسسة مستقلان عن كود ووصف SAP. التحديث يغيّر ربط SAP أو شدّته فقط، ولا يغيّر هوية الصنف بالمؤسسة أو سعره.</p>
    </div></div>
    <section className="panel">
      <div className="section-title"><ClipboardPaste size={20}/><h2>لصق جدول أصناف المؤسسة وSAP</h2></div>
      <p className="hint">الصق جدول الأصناف من SAP أو ملف المؤسسة مع سطر العناوين. لا يوجد اتصال بمشروع خارجي. يمكن استعمال Item No. وItem Description وUoM Name، ومعها «حبات الكرتونة» إن كانت متوفرة. لا نعتبر Quantity شدّة كرتونة. إذا لم تكن الشدّة موجودة يبقى تعريفها السابق كما هو.</p>
      <label>الأصناف وبيانات الشدّات من SAP<textarea dir="ltr" rows={7} value={paste} onChange={e=>{setPaste(e.target.value);setSelected([]);setError('')}} placeholder={'رقم المادة بالمؤسسة\tاسم المادة بالمؤسسة\tItem No.\tItem Description\tحبات الكرتونة\tUoM Name\tوزن الحبة كغم\n11371486\tكريمة المؤسسة\tDAR00005\tكريمة SAP\t20\tPiece\t'}/></label>
      {parsed.errors.map((message,index)=><p className="red" key={index} role="alert">{message}</p>)}
    </section>
    <section className="panel">
      <div className="section-title"><h2>تعديل صنف محدد بدون لصق</h2></div>
      <div className="form-grid">
        <label>رقم المادة بالمؤسسة<input dir="ltr" inputMode="numeric" value={manual.institutionCode} onChange={e=>input('institutionCode',e.target.value)} placeholder="رقم المؤسسة (8 خانات)"/></label>
        <label>اسم المادة بالمؤسسة (للعرض فقط)<input value={current?.name||manual.institutionName} readOnly placeholder="يظهر من المرجع بعد إدخال الرقم"/></label>
        <label>كود SAP المراد استخدامه<input dir="ltr" value={manual.sapCode} onChange={e=>input('sapCode',e.target.value.toUpperCase())} placeholder="DAR00005"/></label>
        <label>اسم الصنف في SAP<input value={manual.sapName} onChange={e=>input('sapName',e.target.value)} placeholder={current?.warehouseName||'وصف الصنف في SAP'}/></label>
        <label>عدد الحبات في كرتونة SAP<input type="number" min="1" step="1" value={manual.cartonPieces} onChange={e=>input('cartonPieces',e.target.value)} placeholder={current?.cartonPieces?.toString()||'غير محدد'}/></label>
        <label>وحدة SAP<select value={manual.sapUnit} onChange={e=>input('sapUnit',e.target.value)}><option value="">بدون تغيير</option><option value="Piece">Piece — حبة</option><option value="Carton">Carton — كرتونة</option><option value="KG">KG — كغم</option></select></label>
        <label>وزن الحبة بالكغم، إن كانت وحدة SAP كيلو<input type="number" min="0.000001" step="any" value={manual.kgPerPiece} onChange={e=>input('kgPerPiece',e.target.value)} placeholder={current?.kgPerPiece?.toString()||'غير محدد'}/></label>
      </div>
      {existingSap&&current&&existingSap.code!==current.code&&<p className="red" role="alert">كود SAP المدخل يتبع رقم مادة آخر بالمؤسسة ({existingSap.code}). لن يُحفظ ربط متعارض.</p>}
      {current&&<p className="hint">الصنف المعتمد: <b>{current.code} — {current.name}</b>. الاسم والسعر الخاصان بالمؤسسة لن يتغيرا.</p>}
    </section>
    <section className="panel">
      <div className="section-title"><h2>مراجعة الاستبدالات قبل الحفظ</h2></div>
      <div className="stats"><div className="stat"><span>الأسطر</span><strong>{rows.length}</strong></div><div className="stat"><span>جاهزة</span><strong>{ready.length}</strong></div><div className="stat"><span>تحتاج مراجعة</span><strong>{rows.filter(row=>row.status==='error').length}</strong></div></div>
      <div className="form-grid"><label>بحث في الجدول<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="رقم المؤسسة أو كود SAP أو الاسم"/></label>
      <div style={{alignSelf:'end'}}><button type="button" className="button secondary" disabled={!ready.length||busy} onClick={()=>setSelected(ready.map(row=>row.line))}>تحديد كل التحديثات الجاهزة</button></div></div>
      <div className="table-scroll"><table><thead><tr><th>اختيار</th><th>رقم المادة بالمؤسسة</th><th>اسم المادة بالمؤسسة</th><th>كود SAP الحالي ← الجديد</th><th>اسم SAP</th><th>الشدّة القديمة ← الجديدة</th><th>الوحدة</th><th>المراجعة</th></tr></thead><tbody>{shown.map(row=><tr key={row.line}>
        <td><input type="checkbox" aria-label={'اختيار السطر '+row.line} checked={selected.includes(row.line)} disabled={row.status!=='ready'||busy} onChange={e=>setSelected(old=>e.target.checked?[...old,row.line]:old.filter(n=>n!==row.line))}/></td>
        <td><code>{row.targetCode||row.institutionCode||'—'}</code></td>
        <td>{row.current?.name||'غير معرف'}</td>
        <td dir="ltr">{row.current?.sapCode||'—'} → {row.sapCode}</td>
        <td>{row.sapName||row.current?.warehouseName||'—'}</td>
        <td dir="ltr">{row.current?.cartonPieces??'—'} → {row.proposed?.cartonPieces??row.cartonPieces??'—'}</td>
        <td>{row.proposed?.sapUnit||'—'}</td>
        <td>{row.status==='error'?<span className="red">{row.reason}</span>:row.status==='ready'?'جاهز':'بدون تغيير'}</td>
      </tr>)}</tbody></table></div>
      {!rows.length&&<p className="hint">الصق بيانات الأصناف أو أدخل رقم المادة بالمؤسسة وكود SAP لعرض المقارنة.</p>}
      {error&&<p className="banner danger" role="alert"><AlertTriangle size={17}/>{error}</p>}
      {notice&&<p className="banner info" role="status"><CheckCircle2 size={17}/>{notice}</p>}
      <div className="save-actions"><span>{selectedCount} تحديثات مختارة · لا يتم حذف أي صنف غير مذكور.</span><button type="button" className="button primary" disabled={busy||!selectedCount} onClick={()=>void save()}><Save size={17}/>{busy?'جارٍ الحفظ…':'حفظ الاستبدالات المختارة'}</button></div>
    </section>
  </div>;
}
