'use client';
import {Fragment,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,CalendarCheck,CheckCircle2,ClipboardCheck,FileSpreadsheet,RefreshCw,ShieldCheck,ArrowLeftRight} from 'lucide-react';
import {listSapFiles,readSapArchive} from '../lib/sap-files-client';
import {readSavedSapImport} from '../lib/saved-sap-import';
import {restoreLieutenantSource} from '../lib/lieutenant-source';
import {buildColonelReport,type ColonelRecord,type ColonelAssignment,type ColonelDayState} from '../lib/colonel-core';
import type {LieutenantTransfer} from '../lib/lieutenant';
import type {CancellationDecision} from '../lib/lieutenant-cancellation-decisions';

type Event={event_type:string;entity_no:string;note:string;created_at:string};
 type ProjectEdit={id:string;branch:string;updated:string};
type SapArchiveActivity={key:string;name:string;kind:string;created:string};
type Signoff={day:string;fingerprint:string;source_key:string;signed_at:string};
type Control={days:ColonelDayState[];assignments:ColonelAssignment[];
 decisions:CancellationDecision[];events:Event[];recentProjectEdits:ProjectEdit[];signoffs:Signoff[]};
const currentMonth=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit'})
 .format(new Date()).slice(0,7);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'})
 .format(new Date());
const empty:Control={days:[],assignments:[],decisions:[],events:[],recentProjectEdits:[],signoffs:[]};
const stateLabels:Record<string,string>={
 normal:'ترحيل وارد',reversed:'عكسي مطابق',reverse:'حركة عكسية',
 'sap-canceled':'ملغى رسميًا في SAP','sap-cancel-doc':'مستند إلغاء SAP',
 'cashvan-pending':'كاش فان — يحتاج مراجعة',
 'cancellation-review':'تصحيح / إلغاء يحتاج إثبات',
 'not-in-current-sap-source':'غير موجود في كشف SAP المقروء',
};
async function readApi<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch(path,body?{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
 }:{cache:'no-store'});
 if(!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
  throw Error(response.redirected||[401,403].includes(response.status)?
   'جلسة الدخول غير متاحة؛ سجّل الدخول مجددًا.':'الخادم أعاد HTML بدل JSON (HTTP '+response.status+').');
 const result=await response.json() as T&{error?:string};
 if(!response.ok)throw Error(result.error||'تعذّر طلب العقيد (HTTP '+response.status+').');
 return result;
}
async function getRecords():Promise<ColonelRecord[]>{
 const result:ColonelRecord[]=[];
 let cursor:{updated:string;id:string}|null=null;
 const seen=new Set<string>();
 for(let i=0;i<250;i++){
  const params=new URLSearchParams({serialExport:'1'});
  if(cursor){params.set('afterUpdated',cursor.updated);params.set('afterId',cursor.id);}
  const response=await readApi<{records:ColonelRecord[];hasMore:boolean;
   nextCursor:{updated:string;id:string}|null}>('/api/reconcile?'+params.toString());
  if(!Array.isArray(response.records))throw Error('استجابة الفواتير ناقصة.');
  for(const record of response.records){
   if(typeof record.id!=='string'||typeof record.payload!=='string'||seen.has(record.id))
    throw Error('تكرار أو تلف سجل أثناء القراءة؛ أُلغي الفحص.');
   seen.add(record.id);result.push(record);
  }
  if(response.hasMore===false)return result;
  if(!response.hasMore||!response.nextCursor||!response.records.length)
   throw Error('قراءة المشروع غير مكتملة؛ لا يجوز إصدار حكم على اليوم.');
  cursor=response.nextCursor;
 }
 throw Error('تجاوز حجم السجلات حد القراءة؛ يلزم ترقيم إضافي.');
}
const displayDate=(value:string)=>value?new Date(value).toLocaleString('ar-JO',{timeZone:'Asia/Amman'}):'—';

export default function Colonel({branches,onOpenRecord,onNavigate,syncVersion=0,syncScope='all'}:{
 branches:string[];onOpenRecord:(id:string)=>void;onNavigate:(view:'lieutenant'|'serial-soldier'|'sap-files')=>void;
 syncVersion?:number;syncScope?:string;
}){
 const [month,setMonth]=useState(currentMonth);
 const lastSync=useRef(syncVersion);
 const [selectedDay,setSelectedDay]=useState('');
 const [records,setRecords]=useState<ColonelRecord[]>([]);
 const [sap,setSap]=useState<LieutenantTransfer[]>([]);
 const [archiveFiles,setArchiveFiles]=useState<SapArchiveActivity[]>([]);
 const [control,setControl]=useState<Control>(empty);
 const [sourceName,setSourceName]=useState('');
 const [sourceKey,setSourceKey]=useState('');
 const [fingerprints,setFingerprints]=useState<Record<string,string>>({});
 const [sourceIssues,setSourceIssues]=useState<string[]>([]);
 const [loaded,setLoaded]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [search,setSearch]=useState('');
 const [manualNo,setManualNo]=useState('');
 const [manualDay,setManualDay]=useState('');
 const [manualReason,setManualReason]=useState('');
 const [lastQueued,setLastQueued]=useState<string[]>([]);
 const reload=useCallback(async()=>{
  setBusy(true);setError('');setNotice('');setLoaded(false);
  try{
   const [project,admin,files]=await Promise.all([
    getRecords(),readApi<Control>('/api/colonel?month='+month),listSapFiles(),
   ]);
   const source=await restoreLieutenantSource(files,branches,readSapArchive,readSavedSapImport);
   setRecords(project);setControl(admin);setSap(source?.scan.transfers||[]);setArchiveFiles(files);
   setSourceIssues(source?.scan.issues||[]);setLastQueued([]);
   setSourceName(source?.name||'');setSourceKey(source?.key||'');
   setLoaded(true);
  }catch(cause){
   setError(cause instanceof Error?cause.message:'تعذّر تحميل بيانات العقيد.');
  }finally{setBusy(false)}
 },[month,branches]);
 useEffect(()=>{void reload()},[reload]);
 useEffect(()=>{
   if(lastSync.current===syncVersion)return;
   lastSync.current=syncVersion;
   if(['reconcile','colonel','sap','all'].includes(syncScope))void reload();
 },[syncVersion,syncScope,reload]);
 const report=useMemo(()=>loaded?buildColonelReport(
  month,records,sap,control.decisions,control.assignments,control.days,
  !!sourceName&&!sourceIssues.length,
 ):null,[month,records,sap,control,loaded,sourceName,sourceIssues.length]);
 const current=report?.days.find(day=>day.day===selectedDay)||null;
 const missingPaper=current?.invoices.filter(inv=>!inv.complete||!/^\d{8,20}$/.test(inv.number))||[];

 // Each day is signed against its own project invoices and SAP transfers.
 // A new, unrelated SAP file must not reopen a previously reviewed day.
 const auditSnapshots=useMemo(()=>report?.days.map(day=>[day.day,JSON.stringify({
  day:day.day,issues:sourceIssues,
  invoices:day.invoices.map(i=>[i.number,i.date,i.amount,i.branch,i.complete,i.recordId,i.dateSource,i.transfers]),
  settlementRecords:day.nonInvoices.map(row=>[row.recordId,row.date,row.state,row.transfers,row.counterparts,row.note]),
  transfers:day.transfers.map(t=>[t.number,t.state,t.postingDate,t.invoiceDay,t.needsAction,t.counterparts,t.note]),
 })] as const)||[],[report,sourceIssues]);
 useEffect(()=>{
  let active=true;setFingerprints({});
  void Promise.all(auditSnapshots.map(async ([day,snapshot])=>{
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(snapshot));
   return [day,Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('')] as const;
  })).then(rows=>{if(active)setFingerprints(Object.fromEntries(rows))})
   .catch(()=>{if(active)setFingerprints({})});
  return ()=>{active=false};
 },[auditSnapshots]);
 const hasConfirmedPaper=(day:NonNullable<typeof current>)=>day.invoices.length>0&&
  day.invoices.every(inv=>inv.complete&&/^\\d{8,20}$/.test(inv.number)&&inv.dateSource!=='transfer');
 const canCloseDay=(day:NonNullable<typeof current>)=>
  hasConfirmedPaper(day)&&day.openCount===0&&!!sourceKey&&!sourceIssues.length&&!!fingerprints[day.day];
 const dayIsClosed=(day:NonNullable<typeof current>)=>{
  const signature=control.signoffs.find(s=>s.day===day.day);
  return !!signature&&!!fingerprints[day.day]&&signature.fingerprint===fingerprints[day.day];
 };
 const signoff=current?control.signoffs.find(s=>s.day===current.day):null;
 const signoffCurrent=!!current&&dayIsClosed(current);
 const fingerprint=current?fingerprints[current.day]||'':'';
 const unmatched=report?.unassigned.filter(t=>t.needsAction)||[];
 const activities=useMemo(()=>{
  const actions=control.events.map(e=>({when:e.created_at,title:
   e.event_type==='complete-day'?'اعتماد إدخال فواتير اليوم':
   e.event_type==='reopen-day'?'إعادة فتح اليوم':
   e.event_type==='close-day'?'إغلاق اليوم بعد مراجعة الفواتير والترحيلات':
    e.event_type==='signoff-day'?'اعتماد اليوم جاهز بعد مراجعة SAP':
   e.event_type==='assign-transfer'?'تحديد تاريخ فاتورة للترحيل':'إلغاء ربط يوم الترحيل',
   description:e.entity_no+' — '+e.note}));
  const reviews=control.decisions.map(e=>({when:e.updated_at,title:'قرار محفوظ لدى الملازم أول',
   description:'الترحيل '+e.transfer_no+' — '+(e.decision==='ignore'?'تجاوز إداري':
    e.decision==='keep'?'عدم الإلغاء بسبب فاتورة':'ربط مستند')+
    (e.related_number?' — '+e.related_number:'')}));
  const archives=archiveFiles.map(e=>({when:e.created,title:'حفظ ملف SAP في الأرشيف',
   description:e.name+' — '+e.kind}));
  const edits=control.recentProjectEdits.map(e=>({when:e.updated,title:'آخر حفظ لمجموعة فواتير في المشروع',
   description:e.branch+' — السجل '+e.id}));
  return [...actions,...reviews,...archives,...edits].filter(e=>Number.isFinite(Date.parse(e.when)))
   .sort((a,b)=>b.when.localeCompare(a.when)).slice(0,35);
 },[control,archiveFiles]);
 const todayActions=activities.filter(e=>new Intl.DateTimeFormat('en-CA',{
  timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.when))===today());
 const filteredInvoices=current?.invoices.filter(inv=>!search||[
  inv.number,inv.branch,inv.recordId,...inv.transfers].some(s=>s.includes(search)))||[];
 const filteredNonInvoices=current?.nonInvoices.filter(doc=>!search||[
  doc.branch,doc.recordId,doc.date,...doc.transfers,...doc.counterparts].some(value=>value.includes(search)))||[];
 const filteredTransfers=current?.transfers.filter(t=>!search||[
  t.number,t.branch,...t.invoiceNumbers,...t.counterparts].some(s=>s.includes(search)))||[];
 async function sendMissingToLieutenant(){
  if(!/^lieutenant\/[a-z]+__[a-f0-9]{32}__[^/]{1,120}$/.test(sourceKey)){
   setError('ارفع كشف ترحيلات SAP إلى أرشيف ملفات SAP أولًا، ولا تستخدم نسخة مشتركة بلا مصدر محفوظ.');return;
  }
  const queued=new Set(lastQueued);
  const candidates=report?[...report.days.flatMap(day=>day.transfers),...report.unassigned]
   .filter(t=>t.source==='sap'&&!t.inProject&&t.needsAction&&t.state==='normal'&&!queued.has(t.number)):[];
  const allowed=new Set(candidates.map(t=>t.number));
  const records=sap.filter(source=>allowed.has(source.transfer.number)&&
   !source.reverse&&!source.signedAdjustment&&source.cancellationState==='active'&&
   !source.issues.length&&!!source.transfer.date&&!!source.transfer.paste);
  if(!records.length){setNotice('لا توجد ترحيلات واردة جديدة قابلة للإرسال للملازم من هذا الكشف.');return;}
  if(!window.confirm('إرسال '+records.length+' ترحيلًا من SAP إلى قائمة متابعة الملازم أول؟ لن تُنشأ فواتير جديدة، والمرسل سابقًا لن يتكرر.'))return;
  setBusy(true);setError('');setNotice('');
  try{
   let added=0,already=0;
   for(let i=0;i<records.length;i+=50){
    const input=records.slice(i,i+50).map(source=>({
     number:source.transfer.number,date:source.transfer.date,paste:source.transfer.paste,
     branch:source.branch,remarks:source.remarks,reverse:source.reverse,
     cancellationState:source.cancellationState,cancellationMentioned:source.cancellationMentioned,
     invoiceNumbers:source.invoiceNumbers,
    }));
    const result=await readApi<{added:number;existing:number;total:number;documents:{number:string;state:string}[]}>(
     '/api/reconcile',{action:'lieutenantImport',sourceFile:sourceKey,transfers:input});
    added+=result.added;already+=result.existing;
    result.documents.forEach(row=>queued.add(row.number));
    setLastQueued([...queued]);
   }
   setNotice('تم إرسال '+added+' ترحيلًا إلى قائمة الملازم، و'+already+' كان موجودًا مسبقًا. لا فواتير منشأة.');
  }catch(cause){setError((cause instanceof Error?cause.message:'تعذّر إرسال الدفعة.')+' قد تكون بعض الدفعات السابقة محفوظة؛ أعد الفحص قبل الإرسال.');}
  finally{setBusy(false)}
 }
 async function action(data:Record<string,string>){
  setBusy(true);setError('');setNotice('');
  try{
   await readApi<{ok:boolean}>('/api/colonel',data);
   setControl(await readApi<Control>('/api/colonel?month='+month));
   setNotice('تم حفظ القرار في العقيد دون تعديل فواتير المشروع أو SAP.');
   setManualNo('');setManualReason('');setManualDay('');
  }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر حفظ القرار.')}
  finally{setBusy(false)}
 }
 async function toggleDayReview(day:NonNullable<typeof current>){
  setSelectedDay(day.day);setError('');setNotice('');
  if(dayIsClosed(day)){
   if(!window.confirm('إعادة فتح يوم '+day.day+' وإلغاء علامة إغلاقه الإداري؟'))return;
   await action({action:'reopen-day',day:day.day});
   return;
  }
  if(!canCloseDay(day)){
   const reasons=[
    !day.invoices.length?'لا توجد فواتير زرقاء مسجلة لهذا اليوم':'',
    day.invoices.some(i=>!i.complete||!/^\\d{8,20}$/.test(i.number))?'توجد فواتير ناقصة أو غير مؤكدة في المشروع':'',
    day.invoices.some(i=>i.dateSource==='transfer')?'تاريخ فاتورة مستنتج من SAP ولم يثبت بتاريخ الورق':'',
    day.openCount?'يوجد '+day.openCount+' حالة تحتاج إجراء داخل اليوم':'',
    !sourceKey||sourceIssues.length?'مصدر SAP غير مكتمل أو غير محفوظ':'',
   ].filter(Boolean);
   setError('لا يمكن إغلاق يوم '+day.day+' قبل معالجة: '+reasons.join('؛ ')+'. تفاصيل اليوم مفتوحة تحت سطره مباشرة.');
   return;
  }
  await action({action:'close-day',day:day.day,fingerprint:fingerprints[day.day],sourceKey});
 }
 return <div>
  <div className="page-title"><div><p className="eyebrow">مركز القيادة والرقابة</p>
   <h1>العقيد — الفواتير والترحيلات والإلغاءات</h1>
   <p>فواتير الأيام تُرتّب بتاريخ الفاتورة الزرقاء؛ تاريخ ترحيل SAP مستقل. بيانات المشروع مرجع الفواتير، وSAP مرجع الحركة والإلغاء الفعلي.</p>
  </div><ShieldCheck size={34}/></div>
  <section className="panel">
   <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end',justifyContent:'space-between'}}>
    <label>شهر المتابعة <input type="month" value={month} disabled={busy}
     onChange={e=>{setMonth(e.target.value);setSelectedDay(e.target.value+'-01')}}/></label>
    <button className="button secondary" disabled={busy} onClick={()=>void reload()}><RefreshCw size={16}/> تحديث قراءة المشروع وSAP</button>
   </div>
   {busy&&<p className="hint">جاري فحص البيانات المحفوظة…</p>}
   {error&&<div role="alert" className="banner error">{error}</div>}
   {notice&&<div role="status" className="banner success">{notice}</div>}
   <p className="hint">مصدر SAP المقروء: {sourceName||'لا يوجد كشف قابل للقراءة'}.
    لا يُعدّ غياب مستند عن ملف ناقص إثباتًا أنه غير مرحّل. ويعتمد فحص الإلغاءات على نفس محرك الملازم أول.</p>
   {sourceIssues.length>0&&<div className="review-list" role="alert">
    <b>تغطية SAP غير مكتملة</b>{sourceIssues.slice(0,12).map((s,i)=><p key={i}>{s}</p>)}
   </div>}
   <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
    <button className="button secondary" onClick={()=>onNavigate('lieutenant')}>فتح الملازم أول</button>
    <button className="button secondary" onClick={()=>onNavigate('serial-soldier')}>فتح جندي السيريل</button>
    <button className="button secondary" onClick={()=>onNavigate('sap-files')}>ملفات SAP</button>
   </div>
  </section>
  {report&&<>
   <div className="stats" style={{marginBottom:14}}>
    <div className="stat"><span>فواتير الشهر بالمشروع</span><strong>{report.stats.invoices}</strong></div>
    <div className="stat"><span>ترحيلات في كشف SAP</span><strong>{report.stats.sapTransfers}</strong></div>
    <div className="stat"><span>حالات مفتوحة</span><strong>{report.stats.open}</strong></div>
    <div className="stat"><span>بلا يوم فاتورة مثبت</span><strong>{report.stats.unassigned}</strong></div>
   </div>
   <section className="panel">
    <div className="section-title"><CalendarCheck size={20}/><div><h2>أيام الفواتير الزرقاء</h2>
     <p>الجمعة تظهر أيضًا إذا عليها فواتير محفوظة؛ لا تنتقل الفواتير ليوم آخر تلقائيًا.</p></div></div>
    <div className="table-scroll"><table><thead><tr><th>اليوم</th><th>الفواتير</th><th>الترحيلات المرتبطة</th>
     <th>بانتظار إجراء</th><th>الحالة</th><th>فتح</th></tr></thead>
     <tbody>{report.days.map(d=><tr key={d.day} style={d.day===current?.day?{background:'var(--theme-info-surface)'}:undefined}>
      <td dir="ltr">{d.day}</td><td>{d.invoices.length}</td><td>{d.transfers.length}</td>
      <td>{d.openCount}</td><td>{d.ready?'جاهز للمراجعة النهائية':d.invoicesComplete?'الفواتير مكتملة — رقابة الترحيلات مفتوحة':'لم تعتمد الفواتير مكتملة'}</td>
      <td><button className="button secondary small" onClick={()=>setSelectedDay(d.day)}>تفاصيل اليوم</button></td>
     </tr>)}</tbody></table></div>
   </section>
   {current&&<section className="panel">
    <div className="section-title"><ClipboardCheck size={20}/><div><h2>تفاصيل {current.day}</h2><p>{current.reason}</p></div></div>
    <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
     {current.invoicesComplete?
      <button className="button secondary" disabled={busy} onClick={()=>void action({action:'reopen-day',day:current.day})}>إعادة فتح إدخال فواتير اليوم</button>:
      <button className="button primary" disabled={busy||missingPaper.length>0||!current.invoices.length}
       onClick={()=>void action({action:'complete-day',day:current.day})}>
       <CheckCircle2 size={17}/> فواتير {current.day} مكتملة</button>}
     <span className="hint">هذا تأكيد إدخال الورق، وليس إلغاء SAP أو إغلاق المخزون.</span>
     {current.ready&&!signoffCurrent&&<button className="button primary"
       disabled={busy||!fingerprint||!sourceKey}
       onClick={()=>void action({action:'signoff-day',day:current.day,fingerprint,sourceKey})}>
       <CalendarCheck size={17}/> اعتماد يوم {current.day} جاهز</button>}
     {signoffCurrent&&<strong style={{color:'var(--theme-success-text)'}}>تم اعتماد اليوم جاهز بعد مراجعة كشف SAP المحفوظ.</strong>}
     {!!signoff&&!signoffCurrent&&<strong className="amber">تغيّرت حالة اليوم أو مصدر SAP بعد آخر اعتماد؛ يحتاج إعادة تدقيق.</strong>}
    </div>
    {missingPaper.length>0&&<p className="amber">يوجد {missingPaper.length} فاتورة زرقاء حقيقية غير مؤكدة أو ناقصة الرقم؛ يجب تصحيحها في سجل المشروع قبل اعتماد اليوم. حركات الإلغاء والعكسي تظهر في قسم التسويات أدناه ولا تُحسب كفواتير ناقصة.</p>}
    <label>بحث داخل اليوم <input value={search} onChange={e=>setSearch(e.target.value)}
      placeholder="رقم فاتورة، ترحيل، فرع أو مجموعة"/></label>
    <h3>الفواتير الزرقاء ({current.invoices.length})</h3>
    <div className="table-scroll"><table><thead><tr><th>رقم الفاتورة</th><th>الفرع</th><th>المبلغ</th>
     <th>الترحيلات المسجلة في المجموعة</th><th>الورق</th><th>المصدر</th></tr></thead>
     <tbody>{filteredInvoices.map((inv,i)=><tr key={inv.recordId+'-'+inv.number+'-'+i}>
      <td><button type="button" className="button secondary small" onClick={()=>onOpenRecord(inv.recordId)}>{inv.number}</button></td>
      <td>{inv.branch}</td><td dir="ltr">{inv.amount}</td><td dir="ltr">{inv.transfers.join('، ')||'—'}</td>
      <td>{inv.complete?'مؤكد':'غير مؤكد'}</td><td>{inv.dateSource==='transfer'?'تاريخ مستنتج — بحاجة إثبات الورق':'تاريخ الفاتورة المحفوظ'}</td>
     </tr>)}</tbody></table></div>
    {current.nonInvoices.length>0&&<>
     <h3>حركات بلا فاتورة زرقاء — تسويات SAP ومراجعتها ({current.nonInvoices.length})</h3>
     <p className="hint">هذه السجلات ليست فواتير ورقية ناقصة. يُعرض مقابلها من الملازم أول إن ثبت العكسي الكامل أو الإلغاء على SAP. المراجعة غير المكتملة تبقى مفتوحة، ولا تُغلق حركات 011 تلقائيًا.</p>
     <div className="table-scroll"><table><thead><tr><th>الترحيل الأصلي</th><th>الفرع</th>
       <th>الترحيل المقابل المثبت</th><th>نتيجة فحص الملازم</th><th>التفاصيل</th></tr></thead>
       <tbody>{filteredNonInvoices.map((doc,i)=><tr key={doc.recordId+'-'+i}>
         <td dir="ltr"><button type="button" className="button secondary small" onClick={()=>onOpenRecord(doc.recordId)}>{doc.transfers.join('، ')}</button></td>
         <td>{doc.branch||'—'}</td>
         <td dir="ltr"><b>{doc.counterparts.join('، ')||'لا يوجد مستند مقابل مثبت'}</b></td>
         <td><span className={'badge '+(doc.state==='settled'?'match':'review')}>{doc.state==='settled'?'مسوّى — لا يحتاج فاتورة زرقاء':doc.state==='pending'?'كاش فان — يحتاج تسوية':'تسوية غير مثبتة'}</span></td>
         <td>{doc.note}{doc.proofs.some(proof=>proof.counterparts.length>0)&&
           <small style={{display:'block'}}>الأصول والمقابل: {doc.proofs.map(proof=>
             proof.number+(proof.counterparts.length?' ← '+proof.counterparts.join('، '):'')).join('؛ ')}</small>}</td>
       </tr>)}</tbody></table></div>
    </>}
    <h3>ترحيلات هذا اليوم ({current.transfers.length})</h3>
    <div className="table-scroll"><table><thead><tr><th>رقم الترحيل</th><th>تاريخ SAP</th>
      <th>فاتورته أو مجموعته</th><th>الحالة / المقابل</th><th>ملاحظة</th></tr></thead>
      <tbody>{filteredTransfers.map(t=><tr key={t.number}>
       <td dir="ltr">{t.number}</td><td dir="ltr">{t.postingDate||'غير مثبت'}</td>
       <td dir="ltr">{t.invoiceNumbers.join('، ')||'بلا فاتورة مثبتة'}</td>
       <td>{stateLabels[t.state]||t.state}{t.counterparts.length?' — مقابل '+t.counterparts.join('، '):''}</td>
       <td>{t.needsAction?<strong>يحتاج إجراء. </strong>:null}{t.note||'—'}</td>
      </tr>)}</tbody></table></div>
   </section>}
   <section className="panel">
    <div className="section-title"><ArrowLeftRight size={20}/><div><h2>إرسال الترحيلات الناقصة للملازم أول</h2>
     <p>فقط ترحيلات SAP الواردة وغير الموجودة في سجلات المشروع، مع أصلها المحفوظ؛ لا تُنشأ فواتير تلقائيًا، ولا تُرسل الإلغاءات أو الكاش فان كفواتير.</p></div></div>
    <button className="button primary" disabled={busy||!sourceKey}
     onClick={()=>void sendMissingToLieutenant()}>إرسال الترحيلات الجديدة إلى قائمة الملازم</button>
    {!!lastQueued.length&&<p className="hint">آخر ما تم التحقق من إرساله في هذه الجلسة: {lastQueued.length} ترحيلًا. الإرسال المتكرر لا ينسخ المستندات المحفوظة.</p>}
   </section>
   <section className="panel">
    <div className="section-title"><AlertTriangle size={20}/><div><h2>ترحيلات بلا يوم فاتورة مثبت ({report.unassigned.length})</h2>
     <p>لا تُنسب ليوم تاريخ ترحيل SAP بالتخمين. يمكن توثيق يومها يدويًا مع السبب، دون إنشاء فاتورة وهمية.</p></div></div>
    <div className="table-scroll"><table><thead><tr><th>الترحيل</th><th>تاريخ SAP</th><th>مرجع الفواتير</th><th>الحالة</th><th>إجراء</th></tr></thead>
     <tbody>{report.unassigned.filter(t=>!search||t.number.includes(search)||t.invoiceNumbers.some(n=>n.includes(search))).slice(0,180).map(t=><tr key={t.number}>
      <td dir="ltr">{t.number}</td><td dir="ltr">{t.postingDate||'—'}</td>
      <td dir="ltr">{t.invoiceNumbers.join('، ')||'—'}</td><td>{stateLabels[t.state]||t.state}
       {t.counterparts.length?' — مقابل '+t.counterparts.join('، '):''}</td>
      <td><button type="button" className="button secondary small"
        onClick={()=>{setManualNo(t.number);setManualDay('');setManualReason('')}}>تحديد يوم الفاتورة</button></td>
     </tr>)}</tbody></table></div>
    {report.unassigned.length>180&&<p className="hint">يعرض أول 180 ترحيلًا؛ استخدم البحث للوصول للرقم المطلوب.</p>}
    {manualNo&&<div style={{border:'1px solid var(--theme-border)',padding:12,borderRadius:10,marginTop:12}}>
     <h3>توثيق تاريخ فاتورة الترحيل {manualNo}</h3>
     <p className="hint">قرار إداري لإسناد الترحيل ليوم متابعة، لا يربطه تلقائيًا برقم فاتورة في قاعدة المشروع.</p>
     <div style={{display:'flex',flexWrap:'wrap',gap:10}}>
      <label>تاريخ الفاتورة <input type="date" value={manualDay} onChange={e=>setManualDay(e.target.value)}/></label>
      <label style={{flex:'1 1 260px'}}>دليل/سبب تحديد اليوم <input value={manualReason}
       onChange={e=>setManualReason(e.target.value)} placeholder="رقم الفاتورة الزرقاء أو مرجع موثّق"/></label>
     </div>
     <div style={{display:'flex',gap:8,marginTop:9}}>
      <button className="button primary" disabled={busy||!manualDay||manualReason.trim().length<6}
        onClick={()=>void action({action:'assign-transfer',transferNo:manualNo,day:manualDay,reason:manualReason})}>حفظ يوم المتابعة</button>
      <button className="button secondary" onClick={()=>setManualNo('')}>إلغاء</button>
     </div>
    </div>}
    {control.assignments.length>0&&<details style={{marginTop:12}}><summary>روابط الأيام اليدوية المحفوظة ({control.assignments.length})</summary>
     <div className="table-scroll"><table><thead><tr><th>الترحيل</th><th>اليوم</th><th>الدليل</th><th>حذف الربط</th></tr></thead>
      <tbody>{control.assignments.map(a=><tr key={a.transfer_no}><td>{a.transfer_no}</td>
       <td>{a.invoice_day}</td><td>{a.reason}</td><td><button className="button secondary small"
       disabled={busy} onClick={()=>void action({action:'clear-assignment',transferNo:a.transfer_no})}>إزالة</button></td></tr>)}</tbody></table></div>
    </details>}
   </section>
   <section className="panel">
    <div className="section-title"><ShieldCheck size={20}/><div><h2>رقابة الإلغاءات والكاش فان من الملازم</h2>
     <p>قرار الملازم محفوظ، لكن حالة SAP لا تتغير إلا بدليل إلغاء رسمي أو عكسي مطابق. يظهر رقم المقابل متى ثبت.</p></div></div>
    <div className="table-scroll"><table><thead><tr><th>الترحيل</th><th>تاريخ SAP</th><th>حالة SAP / التسوية</th>
      <th>المستند المقابل</th><th>قرار الملازم</th><th>تفاصيل الإثبات</th></tr></thead>
     <tbody>{[...report.days.flatMap(d=>d.transfers),...report.unassigned]
      .filter(t=>t.state!=='normal'||!!t.decision)
      .filter(t=>!search||[t.number,...t.counterparts,...t.invoiceNumbers].some(n=>n.includes(search)))
      .sort((a,b)=>Number(b.needsAction)-Number(a.needsAction)||a.number.localeCompare(b.number))
      .slice(0,170).map(t=><tr key={t.number}><td dir="ltr">{t.number}</td>
       <td dir="ltr">{t.postingDate||'—'}</td>
       <td>{stateLabels[t.state]||t.state}</td><td dir="ltr">{t.counterparts.join('، ')||'—'}</td>
       <td>{t.decision==='ignore'?'تجاوز إداري':
        t.decision==='keep'?'لا يُلغى — قرار مرتبط بفاتورة':
        t.decision==='linked'?'ربط إداري':'لم يسجل قرار'}</td>
       <td>{t.needsAction?<strong>متابعة مطلوبة. </strong>:null}{t.note||'لا توجد ملاحظات إضافية'}</td>
      </tr>)}</tbody></table></div>
    <button className="button secondary" onClick={()=>onNavigate('lieutenant')}>الانتقال للملازم أول لمراجعة التفاصيل والقرارات</button>
   </section>
   {(report.undated.length>0||report.warnings.length>0)&&<section className="panel">
    <div className="section-title"><AlertTriangle size={20}/><div><h2>استثناءات لا تُخفى</h2>
     <p>فواتير بلا تاريخ صالح، أرقام مفقودة أو تعارضات مجموعات.</p></div></div>
    {report.undated.map((i,n)=><p key={i.recordId+'-'+n}>الفاتورة {i.number} — المجموعة {i.recordId} — تاريخ الورق غير مثبت
     <button className="button secondary small" onClick={()=>onOpenRecord(i.recordId)}>فتح</button></p>)}
    {report.warnings.slice(0,100).map((w,n)=><p key={n}>{w}</p>)}
   </section>}
   <section className="panel">
    <div className="section-title"><FileSpreadsheet size={20}/><div><h2>نشاط اليوم {today()}</h2>
     <p>آخر حفظ للمشروع + قرارات العقيد الجديدة. لا يدّعي هذا السجل معرفة تاريخ كل تعديل قديم غير مسجل.</p></div></div>
    {todayActions.length?todayActions.map((a,i)=><p key={i}><b>{a.title}</b> · {displayDate(a.when)} — {a.description}</p>):
     <p className="hint">لا توجد عمليات محفوظة بتاريخ اليوم ضمن آخر السجلات المقروءة.</p>}
    <details><summary>أحدث النشاطات ({activities.length})</summary>
     {activities.map((a,i)=><p key={i}>{displayDate(a.when)} — {a.title}: {a.description}</p>)}
    </details>
   </section>
  </>}
 </div>;
}
