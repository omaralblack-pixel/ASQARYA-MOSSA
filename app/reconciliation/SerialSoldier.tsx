'use client';
import {useMemo,useState} from 'react';
import {AlertTriangle,CheckCircle2,Download,FileSpreadsheet,RefreshCw,Upload} from 'lucide-react';
import {serialMergeProposals,previouslyApprovedSerialMerges,evaluateSerial,serialReviewNote,type SerialReport,type SerialRecord,type SerialRow} from '../lib/serial-soldier';

const label={received:'واصل ومطابق',received_difference:'واصلة — فرق في الملاحظات',pending:'الورق غير مؤكد بالسجل',missing:'غير مسجلة بالمشروع',review:'تحتاج مراجعة'};
const color={received:'light-dark(#d8f3dc, var(--theme-success-surface))',received_difference:'light-dark(#fff0bf, var(--theme-warning-surface))',pending:'light-dark(#fad5e5, var(--theme-pink-surface))',missing:'light-dark(#fad5e5, var(--theme-pink-surface))',review:'light-dark(#fff0bf, var(--theme-warning-surface))'};
async function getSaved():Promise<SerialRecord[]> {
 const saved:SerialRecord[]=[];
 const seen=new Set<string>();
 let cursor:{updated:string;id:string}|null=null;
 for(let page=0;page<200;page++){
  const params=new URLSearchParams({serialExport:'1'});
  if(cursor){params.set('afterUpdated',cursor.updated);params.set('afterId',cursor.id);}
  const response=await fetch('/api/reconcile?'+params.toString(),{cache:'no-store'});
  const contentType=(response.headers.get('content-type')||'').toLowerCase();
  if(!contentType.includes('application/json')){
   if(response.redirected||[401,403].includes(response.status))
    throw Error('جلسة الدخول انتهت أو أُعيد توجيهك إلى صفحة الدخول. سجل الدخول مجددًا ثم أعد طلب الكشف.');
   throw Error('تعذّر سحب سجل المشروع: الخادم أعاد صفحة HTML بدل JSON (HTTP '+response.status+'). لا يوجد ملف مكتمل، ولا تغيّر شيء في سجلات المشروع.');
  }
  let data:any;
  try{data=await response.json();}
  catch{throw Error('رد الخادم ليس JSON مكتملًا (HTTP '+response.status+'). لم يتم إنشاء كشف ناقص.');}
  if(!response.ok||!Array.isArray(data?.records))
   throw Error(data?.error||'تعذّر قراءة سجلات المشروع (HTTP '+response.status+').');
  for(const record of data.records){
   if(!record||typeof record.id!=='string'||typeof record.payload!=='string'||seen.has(record.id))
    throw Error('بيانات التصدير ناقصة أو تكررت أثناء تحميل السجل؛ ألغيت العملية لمنع كشف غير سليم.');
   seen.add(record.id);saved.push(record);
  }
  if(data.hasMore===false)return saved;
  if(data.hasMore!==true||!data.nextCursor?.updated||!data.nextCursor?.id||!data.records.length)
   throw Error('انقطع تسلسل صفحات سجل المشروع؛ لم يتم تنزيل كشف ناقص.');
  cursor={updated:data.nextCursor.updated,id:data.nextCursor.id};
 }
 throw Error('سجل المشروع تجاوز حد صفحات التصدير المسموح؛ لا يجوز تسليم كشف غير مكتمل.');
}
export default function SerialSoldier({branches}:{branches:string[]}){
 const [file,setFile]=useState<File|null>(null);
 const [buffer,setBuffer]=useState<ArrayBuffer|null>(null);
 const [report,setReport]=useState<SerialReport|null>(null);
 const [issues,setIssues]=useState<string[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [day,setDay]=useState('');
 const [updated,setUpdated]=useState('');
 const [approvedMerges,setApprovedMerges]=useState<string[]>([]);
 const [mergeNotice,setMergeNotice]=useState('');
 const mergeProposals=useMemo(()=>serialMergeProposals(report?.rows||[]),[report]);
 const duplicateRows=new Set(mergeProposals.flatMap(proposal=>proposal.removeRows));
 const awaitingMerges=mergeProposals.filter(proposal=>!approvedMerges.includes(proposal.number));
 const allRows=useMemo(()=>{
   if(!report)return [];
   const rows=[...report.rows,...report.projectOnly];
   return [...rows.filter(row=>row.origin==='project'),...rows.filter(row=>row.origin!=='project')];
 },[report]);
 const projectOnlyCount=allRows.filter(row=>row.origin==='project'&&!duplicateRows.has(row.row)).length;
 const daily=useMemo(()=>{
   const map=new Map<string,{total:number;received:number;differences:number;pending:number;missing:number;review:number;projectOnly:number}>();
   for(const row of allRows){
     const date=row.date||'تاريخ غير معروف';
     const result=map.get(date)||{total:0,received:0,differences:0,pending:0,missing:0,review:0,projectOnly:0};
     result.total++;
     if(duplicateRows.has(row.row))result.review++;
     else if(row.origin==='project')result.projectOnly++;
     else if(row.state==='received_difference'){result.received++;result.differences++;}
     else result[row.state]++;
     map.set(date,result);
   }
   return [...map].sort(([a],[b])=>a.localeCompare(b));
 },[allRows,report]);
 const filtered=allRows.filter(row=>!day||row.date===day);
 async function checkExcel(nextFile:File){
   setFile(nextFile);setReport(null);setBuffer(null);setIssues([]);setError('');setDay('');setApprovedMerges([]);setMergeNotice('');setBusy(true);
   try{
     if(!/\.xlsx$/i.test(nextFile.name))throw Error('ارفع ملف Excel بصيغة XLSX فقط.');
     const content=await nextFile.arrayBuffer();
     const {readSerialWorkbook}=await import('../lib/serial-workbook');
     const parsed=readSerialWorkbook(content);
     setIssues(parsed.errors);
     const saved=await getSaved();
     const result=evaluateSerial(parsed.rows,saved,parsed.period);
     result.blockers=[...new Set([...parsed.errors,...result.blockers])];
     const priorConsent=previouslyApprovedSerialMerges(parsed.rows,nextFile.name);
     setApprovedMerges(priorConsent);
     if(priorConsent.length)
       setMergeNotice('موافقتك السابقة محفوظة للفاتورة '+priorConsent.join('، ')+
         ' (الصف 144 مع 497). سيُتحقق من ترحيلات وملاحظات الصفين ويُنفذ الدمج عند تنزيل النسخة، وإلا سيتوقف دون فقدان بيانات.');
     setReport(result);setBuffer(content);setUpdated(new Date().toLocaleString('ar-JO'));
   }catch(e){setError(e instanceof Error?e.message:'تعذر تحليل الملف.');}
   finally{setBusy(false);}
 }
 async function refresh(){
   if(!file)return;
   await checkExcel(file);
 }
 async function downloadProjectInvoices(){
   if(busy)return;
   setBusy(true);setError('');
   try{
     const saved=await getSaved();
     const {createProjectInvoicesWorkbook}=await import('../lib/project-invoice-export');
     const {readColonelNotesForExport}=await import('../lib/colonel-notes-client');
     const colonel=await readColonelNotesForExport(branches,saved);
     const blob=createProjectInvoicesWorkbook(saved,colonel.notes);
     if(colonel.warning)setMergeNotice('تنبيه العقيد: '+colonel.warning);
     const url=URL.createObjectURL(blob),a=document.createElement('a');
     a.href=url;
     a.download='جميع-فواتير-المشروع-'+new Date().toISOString().slice(0,10)+'.xlsx';
     a.click();
     setTimeout(()=>URL.revokeObjectURL(url),1200);
   }catch(e){setError(e instanceof Error?e.message:'تعذر تنزيل فواتير المشروع.');}
   finally{setBusy(false);}
 }
 async function download(){
   if(!buffer||!file||!report||busy)return;
   setBusy(true);setError('');
   try{
     const {readSerialWorkbook,createSerialWorkbook}=await import('../lib/serial-workbook');
     const parsed=readSerialWorkbook(buffer);
     setIssues(parsed.errors);
     const saved=await getSaved();
     const fresh=evaluateSerial(parsed.rows,saved,parsed.period);
     fresh.blockers=[...new Set([...parsed.errors,...fresh.blockers])];
     setReport(fresh);
     // Safe final download only: validation rejects duplicates and lost transfers.
     const {readColonelNotesForExport}=await import('../lib/colonel-notes-client');
     const colonel=await readColonelNotesForExport(branches,saved);
     const blob=createSerialWorkbook(buffer,fresh,approvedMerges,colonel.notes);
     const name=file.name.replace(/\.xlsx$/i,'')+'-جندي-السيريل.xlsx';
     setMergeNotice('تم تدقيق عدم التكرار وتجهيز شيت مستقل لكل يوم عمل باستثناء الجمعة.'+
       (colonel.warning?' تنبيه العقيد: '+colonel.warning:''));
     const url=URL.createObjectURL(blob),a=document.createElement('a');
     a.href=url;
     a.download=name;
     a.click();
     setTimeout(()=>URL.revokeObjectURL(url),1200);
     setUpdated(new Date().toLocaleString('ar-JO'));
   }catch(e){setError(e instanceof Error?e.message:'تعذر إنشاء Excel.');}
   finally{setBusy(false);}
 }
 return <div>
   <div className="page-title">
     <div><p className="eyebrow">جندي المطابقة</p><h1>جندي السيريل – فواتير المؤسسة</h1><p>ارفع ملف سجى، وافحص وصول الفواتير ومبالغها وترحيلاتها، واسترجع الملف بنفس التصميم مع التلوين وأرقام الترحيلات.</p></div>
   </div>
   <section className="panel no-print">
     <h2><FileSpreadsheet size={21} style={{verticalAlign:'middle',marginLeft:8}}/>كشف سجى الأصلي</h2>
     <p className="hint">المرجع المعتمد هو سجلات مشروع إدارة المؤسسة؛ ملف سجى للمقارنة فقط. يطابق الجندي أرقام الفواتير أولًا، ثم يصحح في النسخة الناتجة الرقم والتاريخ والفرع والمبلغ وأعمدة الترحيلات وفق المشروع، ويسجل قيم Excel القديمة والاختلافات في الملاحظات دون تعديل قاعدة المشروع أو حذف ملفات المصدر. الترحيلات المشتركة مسموحة فقط إذا ثبتت ضمن المجموعة نفسها في المشروع.</p>
     <p className="hint">الفواتير المسجلة بالمشروع والناقصة من كشف سجى تُضاف في نفس الشيت بالأزرق، مع رقمها وتاريخها وفرعها ومبلغها وترحيلاتها، وملاحظة «موجودة بالمشروع وغير موجودة بكشف سجى». تشمل المقارنة فترة الكشف المكتوبة في عنوان ملف سجى.</p>
     <p className="hint">العقيد يضيف إلى ملاحظات Excel حالة الإلغاء المثبتة في SAP، أو العكسي المطابق ورقمه، أو الكاش فان الذي ما زال يحتاج إجراء. قرارات التجاوز والربط الإداري تظهر بصفتها قرارات، ولا تتحول تلقائيًا إلى إثبات إلغاء. إذا تعذّر قراءة SAP يُكتب تحذير واضح داخل الكشف.</p>
     <div style={{display:'flex',alignItems:'end',gap:12,flexWrap:'wrap',marginBottom:14}}>
       <label style={{flex:'1 1 280px'}}>اختيار Excel سجى (.xlsx)
         <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void checkExcel(f);e.target.value='';}}/>
       </label>
       <button type="button" className="button secondary" onClick={()=>void downloadProjectInvoices()} disabled={busy}><Download size={17}/>تنزيل كشف جميع فواتير المشروع</button>
     </div>
     <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
       <button type="button" className="button secondary" onClick={()=>void refresh()} disabled={!file||busy}><RefreshCw size={16}/>إعادة الفحص من السجل الحالي</button>
       <button type="button" className="button primary" onClick={()=>void download()} disabled={!buffer||!report||busy||awaitingMerges.length>0}><Download size={17}/>تنزيل Excel — شيت لكل يوم عمل</button>
     </div>
     <p className="hint">رقم الفاتورة لا يظهر إلا مرة واحدة؛ الترحيل المشترك مسموح فقط إذا أثبت المشروع أنه ضمن نفس المجموعة. لا يُنشأ Excel مع تكرار غير مسموح أو ترحيل مفقود. كل يوم عمل في شيت مستقل والجمعة عطلة.</p>
     <p className="hint">كشف جميع فواتير المشروع مستقل عن ملف سجى ويشمل كل التواريخ المحفوظة، حتى الفواتير التي لم يُثبت تاريخها. يظهر رقم الفاتورة مرة واحدة، وتُبيَّن السجلات المتعارضة دون حذف أي بيانات.</p>
     <p className="hint">اختلافات المطابقة تبقى للمراجعة، لكن التكرارات غير المسموحة أو فقدان الترحيلات أو فاتورة بتاريخ الجمعة توقف التصدير. يُنقل الصف كاملًا مع K:Q والملاحظات؛ فرز Excel يشمل جميع الأعمدة.</p>
     {mergeNotice&&<p role="status" className="hint">{mergeNotice}</p>}
     {file&&<p className="hint">الملف: <b>{file.name}</b> {updated?'· آخر مطابقة: '+updated:''}{busy?' · جارٍ التحقق…':''}</p>}
     {error&&<p role="alert" className="red"><AlertTriangle size={16} style={{verticalAlign:'middle'}}/> {error}</p>}
     {issues.length>0&&<div role="alert" className="review-list"><strong>سطور Excel غير سليمة:</strong>{issues.map((issue,i)=><p key={i}>{issue}</p>)}</div>}
   </section>
   {report&&mergeProposals.length>0&&<section className="panel no-print" aria-label="موافقات دمج الفواتير المكررة">
     <h2><AlertTriangle size={19} style={{verticalAlign:'middle',marginLeft:8}}/>فواتير مكررة — هل توافق على دمجها؟</h2>
     <p className="hint">نعرض كل رقم فاتورة مكرر وصفوفه، ونحتفظ بالصف الأصلي كما هو. لا يتم الدمج إلا بعد الضغط على الموافقة الصريحة. اختلاف المبلغ أو التاريخ أو الفرع يوقف الدمج لحين تصحيح التعارض.</p>
     {mergeProposals.map(proposal=><div key={proposal.number} className="review-list" style={{marginTop:10,padding:12}}>
       <strong dir="ltr">{proposal.number}</strong>
       <p>الصفوف: {proposal.allRows.join('، ')} · الصف المعتمد بعد الدمج: {proposal.keepRow}</p>
       <p>المبالغ: {proposal.amounts.join(' / ')||'—'} · التواريخ: {proposal.dates.join(' / ')||'—'} · الفروع: {proposal.branches.join(' / ')||'—'}</p>
       <p>{proposal.reason}</p>
       {approvedMerges.includes(proposal.number)?<p className="hint">موافقتك مسجلة؛ بعد اعتماد كل حالات التكرار يمكنك تنزيل الملف المدقق.</p>:
        <button type="button" className="button secondary" disabled={busy||!proposal.canMerge}
          onClick={()=>setApprovedMerges(current=>[...new Set([...current,proposal.number])])}>أوافق على دمج هذه الفاتورة</button>}
     </div>)}
   </section>}
   {report&&<>
     <section className="panel">
       <div className="section-title"><CheckCircle2 size={20}/><div><h2>نتيجة الفحص</h2><p>التصنيف يفصل وصول الورق عن اختلاف الرقم أو المبلغ؛ تُسجل الفروقات بالملاحظات وتُحسب الفواتير المؤكد وصولها ضمن الواصلة. تؤخذ الترحيلات من حركات المستودعات الفعلية.</p></div></div>
       <div className="stats">
         <div className="stat"><span>جميع فواتير سجى</span><strong>{report.rows.filter(row=>row.origin!=='project').length}</strong></div>
         <div className="stat" style={{backgroundColor:'light-dark(#cce5ff, var(--theme-info-surface))'}}><span>بالمشروع فقط — بالأزرق</span><strong>{projectOnlyCount}</strong></div>
         <div className="stat"><span>الفواتير الواصلة (شاملة الفروقات)</span><strong>{report.count.received}</strong></div>
         <div className="stat"><span>منها واصلة مع فرق</span><strong>{report.rows.filter(row=>row.origin!=='project'&&row.state==='received_difference').length}</strong></div>
         <div className="stat"><span>غير مسجلة / ورق غير مؤكد</span><strong>{report.count.missing+report.count.pending}</strong></div>
         <div className="stat"><span>تحتاج مراجعة</span><strong>{report.count.review}</strong></div>
       </div>
       {report.period&&<p className="hint">فترة مقارنة فواتير المشروع: <b dir="ltr">{report.period.from}</b> إلى <b dir="ltr">{report.period.to}</b>. الأزرق يعني أن الفاتورة موجودة عندك وغير موجودة بكشف سجى.</p>}
       {report.blockers.length>0&&<div role="alert" className="review-list" style={{marginTop:15}}>
         <h3><AlertTriangle size={18} style={{verticalAlign:'middle'}}/> {report.blockers.length} أخطاء تحتاج مراجعة</h3>
         <p>الملف الناتج نسخة للمراجعة مع جميع الفروقات. لا تتحول الأخطاء إلى مطابقة معتمدة، ولا يتم تعديل البيانات المحفوظة. «غير مسجلة» تعني غياب رقم الفاتورة عن سجلات المشروع ولا تثبت غياب ورقها. أرقام الصفحات الشخصية لا تدخل في فحص السيريل إطلاقًا.</p>
         <div style={{maxHeight:260,overflowY:'auto'}}>{report.blockers.map((b,i)=><p key={i}>{b}</p>)}</div>
       </div>}
       {report.legacyWarnings.length>0&&<details className="review-list" style={{marginTop:14}}><summary>ملاحظات السجل وربط المجموعات القديمة ({report.legacyWarnings.length})</summary><div style={{maxHeight:240,overflowY:'auto'}}>{report.legacyWarnings.map((item,i)=><p key={i}>{item}</p>)}</div></details>}
       {(report.count.review>0||report.rows.some(row=>row.state==='received_difference'))&&<p className="amber">اختلاف المبلغ أو رقم الفاتورة لا يلغي وصول الورق المؤكد: تُحسب الفاتورة واصلة وتُظلل بالأصفر ويُكتب الفرق في الملاحظات. أما عدم تأكيد الورق أو المطابقة المحفوظة أو وجود مشكلة ربط فعلية فيبقى بحاجة مراجعة أو تأكيد. التنزيل النهائي مشروط بنجاح تدقيق التكرار والترحيلات.</p>}
     </section>
     <section className="panel">
       <h2>ملخص فواتير كل يوم</h2>
       <div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>الإجمالي</th><th>واصل (شامل الفروقات)</th><th>منها بفرق</th><th>بالمشروع فقط — أزرق</th><th>غير مسجلة بالمشروع</th><th>غير مؤكد</th><th>مراجعة</th></tr></thead>
       <tbody>{daily.map(([date,c])=><tr key={date}><td dir="ltr">{date}</td><td>{c.total}</td><td>{c.received}</td><td>{c.differences}</td><td style={{backgroundColor:'light-dark(#cce5ff, var(--theme-info-surface))'}}>{c.projectOnly}</td><td>{c.missing}</td><td>{c.pending}</td><td>{c.review}</td></tr>)}</tbody></table></div>
     </section>
     <section className="panel">
       <div className="table-controls"><h2>تفاصيل الفواتير</h2>
         <label>فلترة حسب اليوم <select aria-label="تصفية فواتير جندي السيريل حسب التاريخ" value={day} onChange={e=>setDay(e.target.value)}><option value="">كل الأيام</option>{daily.map(([date])=><option key={date} value={date}>{date}</option>)}</select></label>
       </div>
       <p className="hint">تظهر الفواتير الزرقاء أولًا هنا، وتُدرج في شيت اليوم الصحيح داخل الملف. يُعرض أول 200 صف للتصفح، ويشمل التصدير جميع الفواتير.</p>
       <div className="table-scroll"><table><thead><tr><th>صف Excel</th><th>رقم الفاتورة</th><th>المبلغ</th><th>الحالة</th><th>رئيسي 001→011</th><th>نواشف 002→011</th><th>تعديلات / عكسي</th><th>ملاحظات</th></tr></thead>
       <tbody>{filtered.slice(0,200).map((item:SerialRow)=>{
         const associated=[...item.transfers,...item.unassignedTransfers];
         const cols=associated.filter(x=>x.kind==='main'||x.kind==='dry');
         const adjustments=associated.filter(x=>x.kind==='adjustment');
         return <tr key={item.row} style={{backgroundColor:duplicateRows.has(item.row)?color.review:item.origin==='project'?'light-dark(#cce5ff, var(--theme-info-surface))':color[item.state]}}>
           <td>{item.row<0?'يُضاف للكشف':item.row}</td><td dir="ltr">{item.number||'—'}</td><td dir="ltr">{item.amount||'—'}</td><td>{duplicateRows.has(item.row)?'مكرر — بانتظار موافقة الدمج':item.origin==='project'?'بالمشروع فقط — غير موجودة بكشف سجى':label[item.state]}</td>
           <td dir="ltr">{cols.filter(t=>t.kind==='main').map(t=>t.number).join('، ')||'—'}</td>
           <td dir="ltr">{cols.filter(t=>t.kind==='dry').map(t=>t.number).join('، ')||'—'}</td>
           <td dir="ltr">{adjustments.map(t=>t.number).join('، ')||'—'}</td><td>{serialReviewNote(item)||'—'}</td>
         </tr>;
       })}</tbody></table></div>
     </section>
   </>}
 </div>;
}
