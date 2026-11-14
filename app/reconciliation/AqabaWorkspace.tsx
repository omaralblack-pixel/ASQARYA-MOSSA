'use client';
import {useEffect,useMemo,useState} from 'react';
import {readAqabaOfficial,readAqabaBlue,compareAqaba,AQABA_CUSTOMER,
 type AqabaLine,type BlueLine} from '../lib/aqaba';
import {defaultAqabaDates,officialAqabaQuery,transferAqabaQuery} from '../lib/aqaba-query';
import {CheckCircle2,AlertTriangle,Copy,FileText,RefreshCw,Save} from 'lucide-react';

const initial=defaultAqabaDates();
type ResponseData={official:AqabaLine[];blue:BlueLine[]};
const template=[
 'رقم الفاتورة الزرقاء\tالتاريخ\tكود SAP\tاسم الصنف\tالكمية\tالوحدة\tالسعر\tأرقام الفواتير الرسمية\tأرقام الترحيلات',
 '2650710367\t2026-11-03\tCHS00561\tجبنة فيتا جولد\t600\tPiece\t0.313\t260063818\t2615754',
].join('\n');
async function request(body?:unknown):Promise<any>{
 const res=await fetch('/api/aqaba',body?{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
 }:{cache:'no-store'});
 if(!(res.headers.get('content-type')||'').includes('application/json'))
   throw Error('خادم العقبة لم يُرجع JSON؛ تحقق من الاتصال أو جلسة الدخول.');
 const data=await res.json();
 if(!res.ok)throw Error(data.error||'تعذّر الاتصال بشاشة العقبة.');
 return data;
}
export default function AqabaWorkspace(){
 const [from,F]=useState(initial.from),[to,T]=useState(initial.to);
 const [officialPaste,OP]=useState(''),[bluePaste,BP]=useState('');
 const [saved,S]=useState<ResponseData>({official:[],blue:[]});
 const [working,W]=useState(false),[error,E]=useState(''),[message,M]=useState('');
 const [search,Q]=useState('');
 const official=useMemo(()=>officialPaste.trim()?readAqabaOfficial(officialPaste):null,[officialPaste]);
 const blue=useMemo(()=>bluePaste.trim()?readAqabaBlue(bluePaste):null,[bluePaste]);
 const mergedOfficial=useMemo(()=>{
  const byKey=new Map(saved.official.map(x=>[x.key,x] as const));
  for(const row of official?.items||[])byKey.set(row.key,row);
  return [...byKey.values()];
 },[saved.official,official]);
 const mergedBlue=useMemo(()=>{
  const byKey=new Map(saved.blue.map(x=>[x.key,x] as const));
  for(const row of blue?.items||[])byKey.set(row.key,row);
  return [...byKey.values()];
 },[saved.blue,blue]);
 const results=useMemo(()=>compareAqaba(mergedBlue,mergedOfficial),[mergedBlue,mergedOfficial]);
 const invoices=useMemo(()=>{
  const by=new Map<string,AqabaLine[]>();
  for(const line of mergedOfficial){
   const key=line.kind+'|'+line.document;
   const lines=by.get(key)||[];lines.push(line);by.set(key,lines);
  }
  return [...by].map(([key,lines])=>({key,lines,first:lines[0],
   amount:lines.reduce((sum,row)=>sum+row.lineTotal+row.tax,0)}))
   .filter(x=>x.key.includes(search)||x.lines.some(y=>y.item.includes(search)))
   .sort((a,b)=>b.first.date.localeCompare(a.first.date)||b.first.document.localeCompare(a.first.document,'en',{numeric:true}));
 },[mergedOfficial,search]);
 const [expanded,EXP]=useState('');
 const load=async()=>{const data=await request() as ResponseData;S(data)};
 useEffect(()=>{load().catch(e=>E(e.message))},[]);
 const copy=async(type:'official'|'transfer')=>{
  try{
   const query=type==='official'?officialAqabaQuery(from,to):transferAqabaQuery(from,to);
   await navigator.clipboard.writeText(query);M('تم نسخ كويري SAP.');
  }catch(e){E('تعذّر نسخ الكويري تلقائيًا. '+(e instanceof Error?e.message:''))}
 };
 const save=async(type:'official'|'blue')=>{
  const read=type==='official'?official:blue;
  if(!read?.items.length){E('لا توجد سطور صالحة للحفظ.');return}
  if(read.issues.length&&!window.confirm('هناك '+read.issues.length+' ملاحظة قراءة. هل تريد حفظ البنود الصالحة فقط مع مراجعة الملاحظات؟'))return;
  W(true);E('');M('');
  try{
   let added=0,updated=0,unchanged=0;
   for(let i=0;i<read.items.length;i+=50){
    const out=await request({action:type==='official'?'aqabaOfficial':'aqabaBlue',
      items:read.items.slice(i,i+50)});
    added+=out.added;updated+=out.updated;unchanged+=out.unchanged;
   }
   await load();M('حُفظت البيانات: '+added+' جديد، '+updated+' تحديث، '+unchanged+' دون تغيير.');
  }catch(e){E((e instanceof Error?e.message:String(e))+' — قد تكون دفعات سابقة حُفظت؛ حدّث السجل قبل إعادة اللصق.')}
  finally{W(false)}
 };
 const matched=results.filter(x=>!x.differences.length&&!x.issues.some(y=>y.includes('الفاتورة الرسمية'))).length;
 return <div dir="rtl" className="aqaba-workspace">
  <div className="page-title"><div><p className="eyebrow">الزبون {AQABA_CUSTOMER} · المستودع 011</p>
   <h1>مؤسسة العقبة — الفواتير والمطابقة</h1><p>من 01/11/2026؛ فصل كامل عن بيانات مؤسسة عمّان. لا يُعتبر أي مستند سببًا لخصم المخزون ما لم تثبته حركات SAP.</p></div>
   <button type="button" className="button secondary" onClick={()=>{E('');void load().then(()=>M('تم تحديث سجل العقبة.')).catch(e=>E(e.message))}}><RefreshCw size={16}/>تحديث السجل</button>
  </div>
  {error&&<div className="banner error" role="alert">{error}</div>}
  {message&&<div className="banner info" role="status">{message}</div>}
  <section className="panel">
   <div className="section-title"><FileText size={20}/><div><h2>كويريات SAP للعقبة</h2>
    <p>غيّر الفترة ثم انسخ كويري الفواتير أو الترحيلات. كليهما يظهر الإلغاءات ولا يستبعدها.</p></div></div>
   <div className="form-grid">
    <label>من تاريخ<input type="date" min="2026-11-01" value={from} onChange={e=>F(e.target.value)}/></label>
    <label>إلى تاريخ<input type="date" min="2026-11-01" value={to} onChange={e=>T(e.target.value)}/></label>
    <button className="button secondary" type="button" onClick={()=>copy('official')}><Copy size={16}/>نسخ كويري الفواتير والإلغاءات</button>
    <button className="button secondary" type="button" onClick={()=>copy('transfer')}><Copy size={16}/>نسخ كويري ترحيلات 011</button>
   </div>
   <p className="hint">كويري الفواتير يشمل IN وCN وDN وRE بحالات N وY وC، وكويري الترحيلات يشمل كل دخول وخروج من 011. لا تحذف المستند الملغي؛ نحتاجه لتفسير المقابل. الترحيل لا يُصنّف للعقبة إلا إذا ثبت من Remarks أو من الربط اليدوي.</p>
  </section>
  <section className="panel">
   <div className="section-title"><FileText size={20}/><div><h2>لصق الفواتير الرسمية من SAP</h2>
    <p>الصق كامل جدول الكويري مع العناوين، بما فيه الفواتير الملغاة والإشعارات الدائنة. لا تُحذف الحركات القديمة من السجل.</p></div></div>
   <textarea dir="ltr" style={{minHeight:175,width:'100%'}} aria-label="كشف SAP الرسمي للعقبة" placeholder="نوع المستند&#9;رقم الفاتورة&#9;DocEntry&#9;التاريخ ..." value={officialPaste} onChange={e=>OP(e.target.value)}/>
   <div className="row-actions"><span>{official?.items.length||0} بند قابل للحفظ · {official?.issues.length||0} ملاحظات</span>
    <button type="button" className="button primary" disabled={working||!official?.items.length} onClick={()=>save('official')}><Save size={16}/>حفظ الفواتير الرسمية</button></div>
   {!!official?.issues.length&&<details><summary>ملاحظات قراءة الفواتير الرسمية</summary>{official.issues.slice(0,80).map((e,i)=><p key={i} className="red">{e}</p>)}</details>}
  </section>
  <section className="panel">
   <div className="section-title"><FileText size={20}/><div><h2>لصق الفواتير الزرقاء وأسعار العقبة</h2>
    <p>ألصق بنود الزرقاء بالأعمدة المطلوبة؛ سعر العقبة يُحفظ مع الفاتورة والتاريخ ولا يغير أسعار مؤسسة عمّان.</p></div></div>
   <details><summary>مثال تنسيق اللصق (بالعناوين)</summary><pre dir="ltr" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{template}</pre></details>
   <textarea dir="ltr" style={{minHeight:155,width:'100%'}} aria-label="بنود الفواتير الزرقاء للعقبة" placeholder="رقم الفاتورة الزرقاء، التاريخ، كود SAP، الكمية، الوحدة، السعر، الفاتورة الرسمية، الترحيلات — مفصولة بـ Tab" value={bluePaste} onChange={e=>BP(e.target.value)}/>
   <div className="row-actions"><span>{blue?.items.length||0} بند صالح · {blue?.issues.length||0} ملاحظات</span>
    <button type="button" className="button primary" disabled={working||!blue?.items.length} onClick={()=>save('blue')}><Save size={16}/>حفظ الزرقاء وأسعارها</button></div>
   {!!blue?.issues.length&&<details><summary>ملاحظات قراءة الزرقاء</summary>{blue.issues.slice(0,80).map((e,i)=><p key={i} className="red">{e}</p>)}</details>}
  </section>
  <section className="panel">
   <div className="section-title"><CheckCircle2 size={20}/><div><h2>مراجعة الربط والمطابقة الجزئية</h2>
    <p>نتيجة الزرقاء ↔ الفواتير الرسمية فقط؛ الترحيلات وOINM لا تزال تحتاج فحصًا مستقلًا. اختلاف الوحدة يظل فرقًا حتى تثبت الشدّة.</p></div></div>
   <div className="stats"><div className="stat"><span>فواتير رسمية</span><strong>{new Set(mergedOfficial.filter(x=>x.kind==='IN').map(x=>x.document)).size}</strong></div>
    <div className="stat"><span>فواتير زرقاء</span><strong>{new Set(mergedBlue.map(x=>x.invoice)).size}</strong></div>
    <div className="stat"><span>زرقاء دون فروق رسمية مثبتة</span><strong>{matched}</strong></div></div>
   {!results.length?<p className="hint">لا توجد فواتير زرقاء محفوظة بعد. الصق الفواتير أولًا ثم أربط أرقام الفواتير الرسمية.</p>:<div style={{overflowX:'auto'}}><table><thead><tr><th>الزرقاء</th><th>الفاتورة الرسمية</th><th>الترحيلات</th><th>حالة الفحص</th><th>تفاصيل</th></tr></thead>
    <tbody>{results.map(x=><tr key={x.invoice}><td>{x.invoice}</td><td>{x.officialNumbers.join('، ')||'غير مربوط'}</td><td>{x.transferNumbers.join('، ')||'غير مربوط'}</td><td>{x.status}</td><td>{x.issues.map((v,i)=><p key={i} className="red">{v}</p>)}{x.differences.map(d=><p key={d.key}>{d.key}: الزرقاء {d.blue} / الرسمية {d.official} / الفرق {d.difference}</p>)}</td></tr>)}</tbody>
   </table></div>}
  </section>
  <section className="panel">
   <div className="section-title"><AlertTriangle size={20}/><div><h2>سجل جميع المستندات الرسمية</h2>
    <p>حالات الإلغاء Y وC لا تُخفى. رقم المستند المرجعي معروض، لكن الربط لم يُثبت تلقائيًا دون بيانات SAP المقابلة.</p></div></div>
   <input type="search" placeholder="ابحث برقم المستند أو كود الصنف" aria-label="بحث مستندات العقبة" value={search} onChange={e=>Q(e.target.value)}/>
   <div style={{overflowX:'auto'}}><table><thead><tr><th>المستند</th><th>تاريخ</th><th>حالة SAP</th><th>بنود</th><th>المبلغ قبل/بعد الضريبة</th><th>مرجع</th></tr></thead>
    <tbody>{invoices.slice(0,120).map(x=><>
     <tr key={x.key} onClick={()=>EXP(expanded===x.key?'':x.key)} style={{cursor:'pointer'}}>
      <td>{x.first.kind} {x.first.document}</td><td>{x.first.date}</td><td>{x.first.canceled}</td>
      <td>{x.lines.length}</td><td>{x.amount.toFixed(3)}</td>
      <td>{[...new Set(x.lines.map(l=>l.baseRef).filter(Boolean))].join('، ')||'غير مثبت'}</td>
     </tr>{expanded===x.key&&<tr key={x.key+'-detail'}><td colSpan={6}><div>{x.lines.map(line=><p key={line.key} dir="auto">{line.item} · {line.description} · {line.quantity} {line.unit||'وحدة غير مذكورة'} × {line.unitPrice.toFixed(3)} — مستند مرجعي {line.baseRef||'غير مثبت'}</p>)}</div></td></tr>}
    </>)}</tbody></table></div>
   {invoices.length>120&&<p className="hint">يعرض أول 120 مستندًا؛ استخدم البحث للوصول للبقية.</p>}
  </section>
  <p className="hint">تدقيق المخزون الفعلي يستمر من الملازم أول مع كشف OINM. الشاشة لا تعتبر أي خصم افتراضيًا ولا تمنح اعتمادًا نهائيًا بلا ترحيلات مثبتة.</p>
 </div>;
}
