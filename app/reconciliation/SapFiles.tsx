'use client';
import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {FileUp,RefreshCw,FileArchive,Download,Trash2,AlertTriangle,Copy} from 'lucide-react';
import {decodeLieutenantFile} from '../lib/lieutenant-file';
import {classifySapFile,sapKinds,type SapKind,type SapJob} from '../lib/sap-processing';
import {maxSapFileBytes,readSavedSapImport,saveSapImport} from '../lib/saved-sap-import';
import {listSapFiles,readSapArchive,sapRequest,type SapArchiveFile} from '../lib/sap-files-client';
import {parseLieutenantTransfers} from '../lib/lieutenant';
import {isUnifiedSapSource,splitUnifiedSapSource,unifiedSapQuery} from '../lib/unified-sap-query';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const uploadDay=(date:string)=>date&&Number.isFinite(Date.parse(date))?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date)):'';
const uploadTime=(date:string)=>date&&Number.isFinite(Date.parse(date))?uploadDay(date)+' '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Amman',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(date)):'';
const statusNames={complete:'مكتمل',review:'اكتملت الدفعات — بحاجة مراجعة',archived:'محفوظ — نوع غير معروف',pending:'بانتظار المعالجة',running:'قيد المعالجة',failed:'دفعات فاشلة — يمكن استكمالها'};
export default function SapFiles(){
 const [files,F]=useState<SapArchiveFile[]>([]),[jobs,J]=useState<Record<string,SapJob>>({}),[job,SJ]=useState<SapJob|null>(null);
 const [kind,K]=useState<SapKind>('unified'),[date,D]=useState(today()),[busy,B]=useState(false),[loading,L]=useState(true),[error,E]=useState(''),[message,M]=useState('');
 const [query,Q]=useState(''),[filter,FL]=useState('all'),[balanceFrom,BF]=useState(''),[balanceTo,BT]=useState(''),[uploadFrom,UF]=useState(''),[uploadTo,UT]=useState('');
 const [opened,OPEN]=useState<{file:SapArchiveFile;text:string}|null>(null);
 const [fromDate,FROM]=useState(()=>today().slice(0,8)+'01'),[toDate,TO]=useState(today());
 const queryRef=useRef<HTMLTextAreaElement>(null);
 const lock=useRef(false),mounted=useRef(true);
 let unifiedSql='',queryError='';
 try{unifiedSql=unifiedSapQuery(fromDate,toDate);}catch(e){queryError=e instanceof Error?e.message:'فترة غير صالحة.';}
 async function copyUnifiedSql(){
  if(!unifiedSql)return;
  try{await navigator.clipboard.writeText(unifiedSql);M('تم نسخ كويري SAP الشامل. شغّله في SAP وصدّر النتيجة إلى ملف واحد.');}
  catch{queryRef.current?.focus();queryRef.current?.select();M('المتصفح منع النسخ التلقائي؛ تم تحديد الكويري. اضغط Ctrl+C.');}
 }
 async function archiveUnifiedParts(file:SapArchiveFile,text:string){
  if(!isUnifiedSapSource(text))return;
  const sections=splitUnifiedSapSource(text);
  const parts=[
   {kind:'transfers',body:sections.transfers,date:'',count:sections.counts.TRANSFER},
   {kind:'opening',body:sections.opening,date:sections.from,count:sections.counts.OPENING},
   {kind:'balance',body:sections.closing,date:sections.to,count:sections.counts.CLOSING},
  ] as const;
  for(const part of parts){
   if(!part.count)continue;
   const name=file.name.replace(/\.[^.]+$/,'')+'-'+part.kind+'-'+(part.date||sections.from+'-'+sections.to)+'.txt';
   const res=await fetch('/api/lieutenant-files',{method:'POST',headers:{'Content-Type':'text/plain',
    'X-File-Name':encodeURIComponent(name),'X-File-Kind':part.kind,'X-Snapshot-Date':part.date},
    body:new TextEncoder().encode(part.body)});
   if(!res.ok){
    const result=await res.json().catch(()=>({error:''})) as {error?:string};
    throw Error(result.error||'تعذّر أرشفة جزء '+part.kind+' من الملف الموحد؛ الأصل محفوظ.');
   }
  }
 }

 const remember=(value:SapJob)=>{if(!mounted.current)return;SJ(value);J(old=>({...old,[value.key]:value}));};
 async function refresh(){
  const [archive,processing]=await Promise.allSettled([listSapFiles(),sapRequest<{jobs:SapJob[]}>('/api/sap-processing')]);
  if(!mounted.current)return;
  if(archive.status==='fulfilled')F(archive.value);
  if(processing.status==='fulfilled'){
   J(Object.fromEntries(processing.value.jobs.map(x=>[x.key,x])));
   const selected=job?.key||processing.value.jobs.find(x=>['pending','running','failed'].includes(x.status))?.key;
   if(selected){const result=await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(selected));if(result.job)remember(result.job);}
  }
  const failures=[archive,processing].filter((x):x is PromiseRejectedResult=>x.status==='rejected');
  if(failures.length)throw Error(failures.map(x=>x.reason instanceof Error?x.reason.message:String(x.reason)).join(' '));
 }
 useEffect(()=>{mounted.current=true;void refresh().catch(e=>E(e.message)).finally(()=>L(false));return()=>{mounted.current=false};},[]);
 async function exclusive(action:()=>Promise<void>){
  if(lock.current)return;lock.current=true;B(true);E('');M('');
  try{await action();}catch(e){if(mounted.current)E(e instanceof Error?e.message:'تعذّر إتمام الطلب.');}
  finally{lock.current=false;if(mounted.current)B(false);}
 }
 async function publishShared(file:SapArchiveFile,text:string){
  const sourceKind=classifySapFile(text);
  if(sourceKind!=='transfers'&&sourceKind!=='unified')return;
  const sharedText=sourceKind==='unified'?splitUnifiedSapSource(text).transfers:text;
  if(!parseLieutenantTransfers(sharedText,[]).transfers.length)return;
  const previous=await readSavedSapImport();
  if(previous?.text===sharedText)return;
  const last=(source:string)=>parseLieutenantTransfers(source,[]).transfers.reduce((max,x)=>x.transfer.date>max?x.transfer.date:max,'');
  // An old export can be archived/processed without replacing a newer shared view.
  if(previous&&last(previous.text)>last(sharedText))return;
  await saveSapImport({name:file.name,text:sharedText});
 }
 async function processFile(file:SapArchiveFile,text?:string,recheck=false):Promise<void>{
  const current=await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(file.key));
  let state=current.job;
  if(!state||recheck){
   const source=text??await readSapArchive(file);
   state=(await sapRequest<{job:SapJob}>('/api/sap-processing',{action:'start',key:file.key,text:source,recheck})).job;
  }
  const archiveKind=['transfers','balance','opening'].includes(state.kind)?state.kind:'other';
  if(file.kind!==archiveKind){
   const raw=await fetch('/api/lieutenant-files?key='+encodeURIComponent(file.key));
   if(!raw.ok)throw Error('تعذّر فتح الأصل لتصحيح تصنيفه.');
   const copied=await fetch('/api/lieutenant-files',{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name),'X-File-Kind':archiveKind},body:await raw.arrayBuffer()});
   const result=await copied.json() as {key:string;error?:string};
   if(!copied.ok)throw Error(result.error||'تعذّر حفظ النسخة المصنّفة.');
   await refresh();
   return processFile({...file,key:result.key,kind:archiveKind,snapshotDate:''},text);
  }
  remember(state);
  if(state.kind==='unified')await archiveUnifiedParts(file,text??await readSapArchive(file));
  if(state.kind==='transfers'||state.kind==='unified')await publishShared(file,text??await readSapArchive(file));
  // Only unfinished batches are requested. Finished batches survive reloads and
  // independent tabs; the server lease serializes claims for the same batch.
  for(const batch of state.batches.filter(x=>x.state!=='complete')){
   if(!mounted.current)return;
   const result=await sapRequest<{job:SapJob;busy?:boolean}>('/api/sap-processing',{action:'batch',key:file.key,index:batch.idx});
   state=result.job;remember(state);
   if(result.busy){M('هناك طلب يعالج هذه الدفعة. حدّث الحالة أو استكمل بعد انتهاء الطلب؛ لن تتكرر المستندات.');return;}
   if(state.batches.find(x=>x.idx===batch.idx)?.state==='failed'){E('توقفت المعالجة عند دفعة فاشلة. الدفعات الناجحة محفوظة؛ اضغط «استكمال / إعادة محاولة» بعد مراجعة الخطأ.');return;}
  }
  M(state.total===state.done?'انتهت جميع الدفعات المطلوبة. '+(state.issues.length?'توجد ملاحظات قراءة تحتاج مراجعة.':'البيانات متاحة للشاشات المرتبطة.'):'المعالجة غير مكتملة.');
 }
 async function upload(event:ChangeEvent<HTMLInputElement>){
  const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(!file)return;
  await exclusive(async()=>{
   if(!file.size||file.size>maxSapFileBytes)throw Error('اختر ملفًا بحجم من 1 بايت إلى 16 ميغابايت.');
   const bytes=await file.arrayBuffer();let text='',detected:SapKind='other',issue='';
   try{text=decodeLieutenantFile(bytes,file.name);detected=classifySapFile(text);}catch(e){issue=e instanceof Error?e.message:'تعذّر قراءة الملف.';}
   const needsDate=detected==='balance'||detected==='opening';
   if(needsDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today()||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))throw Error('اختر تاريخ الرصيد الفعلي الصحيح قبل الرفع.');
   const archiveKind=['transfers','balance','opening'].includes(detected)?detected:'other';
   const res=await fetch('/api/lieutenant-files',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-File-Kind':archiveKind,'X-Snapshot-Date':needsDate?date:''},body:bytes});
   const saved=await res.json() as {key:string;error?:string};if(!res.ok)throw Error(saved.error||'تعذّر حفظ الملف الأصلي.');
   K(detected);await refresh();
   if(!text){M('حُفظ الملف الأصلي؛ '+issue);return;}
   const stored={key:saved.key,name:file.name,kind:archiveKind,created:'',snapshotDate:needsDate?date:''};
   OPEN({file:stored,text});
   await processFile(stored,text);await refresh();
  });
 }
 async function stamp(file:SapArchiveFile){
  await exclusive(async()=>{
   const text=await readSapArchive(file),actual=classifySapFile(text);
   if(actual!=='balance'&&actual!=='opening')throw Error('هذا الملف ليس كشف رصيد معروفًا.');
   if(!date||date>today()||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('اختر تاريخ الرصيد الصحيح أعلى الصفحة.');
   if(!confirm('هل هذا الكشف يمثل '+(actual==='opening'?'الرصيد قبل أول حركة بتاريخ ':'الرصيد بنهاية يوم ')+date+'؟ ستُحفظ نسخة مؤرخة ويبقى الأصل.'))return;
   const raw=await fetch('/api/lieutenant-files?key='+encodeURIComponent(file.key));if(!raw.ok)throw Error('تعذّر قراءة الأصل.');
   const saved=await fetch('/api/lieutenant-files',{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name),'X-File-Kind':actual,'X-Snapshot-Date':date},body:await raw.arrayBuffer()});
   const out=await saved.json() as {key:string;error?:string};if(!saved.ok)throw Error(out.error||'تعذّر تثبيت التاريخ.');
   await processFile({...file,key:out.key,snapshotDate:date},text);await refresh();
  });
 }
 async function remove(file:SapArchiveFile){
  if(!confirm('حذف الملف الأصلي «'+file.name+'» من الأرشيف نهائيًا؟ لن تُحذف المطابقات أو قرارات الإلغاء أو المستندات المعالجة.'))return;
  await exclusive(async()=>{
   const res=await fetch('/api/lieutenant-files',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:file.key})});
   const out=await res.json() as {deleted?:boolean;error?:string};if(!res.ok||!out.deleted)throw Error(out.error||'لم يؤكد الخادم الحذف.');
   if(opened?.file.key===file.key)OPEN(null);await refresh();M('حُذف الملف المحدد من الأرشيف.');
  });
 }
 const visible=files.filter(file=>{
  const actual=jobs[file.key]?.kind||file.kind,uploaded=uploadDay(file.created),snapshot=file.snapshotDate||'';
  return (!query||(file.name+' '+sapKinds[actual as SapKind]).toLowerCase().includes(query.trim().toLowerCase()))&&
   (filter==='all'||actual===filter)&&(!balanceFrom||!!snapshot&&snapshot>=balanceFrom)&&(!balanceTo||!!snapshot&&snapshot<=balanceTo)&&(!uploadFrom||uploaded>=uploadFrom)&&(!uploadTo||uploaded<=uploadTo);
 });
 return <div className="sap-files">
  <div className="page-title"><div><p className="eyebrow">إدارة المؤسسة · المصدر المشترك</p><h1>ملفات SAP</h1><p>ارفع الكشف مرة واحدة. تبقى النسخة الأصلية محفوظة وتستخدم الشاشات المرتبطة البيانات المشتركة.</p></div><FileArchive size={32}/></div>
  <section className="panel"><h2>رفع ملف SAP جديد</h2><div className="table-controls">
   <label>نوع الملف المتوقع (يُصحّح تلقائيًا)<select value={kind} disabled={busy} onChange={e=>K(e.target.value as SapKind)}>{Object.entries(sapKinds).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
   <label>تاريخ الرصيد الفعلي<input type="date" max={today()} value={date} disabled={busy} onChange={e=>D(e.target.value)}/></label>
   <label className="button primary sap-file-picker"><FileUp size={16}/>إرفاق وحفظ في قاعدة البيانات<input type="file" accept=".txt,.tsv,.csv,.xlsx" aria-label="رفع ملف SAP جديد" disabled={busy} onChange={upload}/></label>
  </div>{kind==='unified'&&<div className="sap-unified-query" aria-label="الكويري الشامل — SAP 011">
   <div className="sap-unified-query-top"><div><h3>الكويري الشامل — SAP 011</h3><p>استخرج الترحيلات والأرصدة والحركات ومستندات العقبة مرة واحدة.</p></div>
    <label>من تاريخ<input type="date" value={fromDate} max={today()} onChange={e=>FROM(e.target.value)}/></label>
    <label>إلى تاريخ<input type="date" value={toDate} max={today()} onChange={e=>TO(e.target.value)}/></label>
    <button type="button" className="button secondary" disabled={!unifiedSql} onClick={()=>void copyUnifiedSql()}><Copy size={15}/>نسخ الكويري</button>
   </div>
   <textarea ref={queryRef} aria-label="كويري SAP الشامل" dir="ltr" readOnly rows={4} value={unifiedSql} />
   {queryError&&<p className="red" role="alert">{queryError}</p>}
   <p className="hint">شغّل الكويري في SAP، وصدّر النتائج إلى Excel أو TXT، ثم اضغط «إرفاق وحفظ في قاعدة البيانات». يحفظ النظام الملف الأصلي ويجهّز النسخ المقروءة للشاشات القديمة دون حذفها.</p>
  </div>}<p className="hint">التاريخ مطلوب لكشوف الرصيد فقط: الختامي بنهاية اليوم، والافتتاحي قبل أول حركة في اليوم. تاريخ الرفع مستقل ولا يُستخدم بدل تاريخ الرصيد. التصنيف يعتمد الأعمدة الفعلية.</p>
  <details><summary>لصق كشف SAP بدل إرفاق ملف</summary><SapPaste disabled={busy} onFile={file=>{void upload({currentTarget:{files:[file],value:''}} as unknown as ChangeEvent<HTMLInputElement>);}}/></details>
  </section>
  <section className="panel" aria-label="حالة معالجة ملفات SAP"><div className="section-title"><h2>حالة التحديث والمعالجة</h2><button className="button secondary" disabled={busy||loading} onClick={()=>void exclusive(refresh)}><RefreshCw size={16}/>تحديث الحالة والأرشيف</button></div>
   {loading&&<p role="status">جارٍ قراءة الأرشيف والحالات المحفوظة…</p>}
   {busy&&<p role="status">جارٍ حفظ الملف أو معالجة الدفعات. يمكن استكمال الدفعات المحفوظة بعد تحديث الصفحة.</p>}
   {error&&<p className="banner error" role="alert"><AlertTriangle size={16}/>{error}</p>}{message&&<p className="banner info" role="status">{message}</p>}
   {job?<><p role="status"><b>{statusNames[job.status]}</b> · {job.done} من {job.total} دفعة · {job.count} مستند/بند · وقت الدفعات: {(job.duration/1000).toFixed(2)} ثانية</p>
    <progress aria-label="الدفعات المكتملة" value={job.total?job.done:['complete','review'].includes(job.status)?1:0} max={job.total||1} style={{width:'100%'}}/>
    {job.batches.filter(x=>x.state!=='complete').map(x=><p key={x.idx} className={x.error?'red':'hint'}>دفعة {x.idx+1}: {x.state==='failed'?'فشلت':x.state==='running'?'قيد المعالجة':'بانتظار المعالجة'} {x.error}</p>)}
    {!!job.issues.length&&<details open><summary>ملاحظات القراءة ({job.issues.length})</summary>{job.issues.map((issue,i)=><p className="red" key={i}>{issue}</p>)}</details>}
    {!!job.documents.length&&<details><summary>نتيجة تصنيف مستندات SAP ({job.documents.length})</summary><div className="table-scroll" style={{maxHeight:450}}><table><thead><tr><th>المستند</th><th>الحالة</th><th>السبب</th></tr></thead><tbody>{job.documents.map(x=><tr key={x.number}><td>{x.number}</td><td>{{pending:'لم يؤكد حفظه بعد',added:'مضاف',existing:'موجود مسبقًا',excluded:'مستبعد من جندي الفواتير'}[x.state]||x.state}</td><td>{x.reason}</td></tr>)}</tbody></table></div></details>}
   </>:<p className="hint">اختر «حالة / استكمال» بجانب ملف لعرض نتيجته المحفوظة. فتح الصفحة لا يعيد المعالجة.</p>}
  </section>
  <section className="panel"><h2>أرشيف ملفات SAP</h2><div className="form-grid">
   <label>بحث باسم الملف<input type="search" value={query} onChange={e=>Q(e.target.value)}/></label><label>نوع الملف<select value={filter} onChange={e=>FL(e.target.value)}><option value="all">جميع الأنواع</option>{Object.entries(sapKinds).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>تاريخ الرصيد من<input type="date" value={balanceFrom} onChange={e=>BF(e.target.value)}/></label><label>تاريخ الرصيد إلى<input type="date" value={balanceTo} onChange={e=>BT(e.target.value)}/></label>
   <label>تاريخ الرفع من<input type="date" value={uploadFrom} onChange={e=>UF(e.target.value)}/></label><label>تاريخ الرفع إلى<input type="date" value={uploadTo} onChange={e=>UT(e.target.value)}/></label>
  </div><p className="hint">{visible.length} من {files.length} ملفًا. «لم تُسجّل معالجة» تعني أن الملف قديم ولا يوجد سجل معالجة له؛ لا تعني فشل قراءته في التقارير.</p>
  <div className="table-scroll"><table><thead><tr><th>الملف</th><th>النوع</th><th>تاريخ الرصيد</th><th>تاريخ الرفع</th><th>حالة المعالجة</th><th>الإجراءات</th></tr></thead><tbody>{visible.map(file=>{
   const state=jobs[file.key];return <tr key={file.key}><td dir="auto">{file.name}</td><td>{sapKinds[(state?.kind||file.kind) as SapKind]||file.kind}</td><td dir="ltr">{file.snapshotDate||'—'}</td><td dir="ltr">{uploadTime(file.created)}</td><td>{state?statusNames[state.status]+' ('+state.done+'/'+state.total+')':'لم تُسجّل معالجة'}{state?.failed?` · ${state.failed} فاشلة`:''}</td><td><div className="row-actions">
    <button className="button secondary small" disabled={busy} onClick={()=>void exclusive(async()=>{OPEN({file,text:await readSapArchive(file)});const result=await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(file.key));SJ(result.job);})}>فتح</button>
    <a className="button secondary small" href={'/api/lieutenant-files?key='+encodeURIComponent(file.key)} download={file.name}><Download size={14}/>تنزيل</a>
    <button className="button secondary small" disabled={busy} onClick={()=>void exclusive(()=>processFile(file))}>{state?.status==='complete'?'تحقق من المعالجة':'حالة / استكمال'}</button>
    {state&&<button className="button secondary small" disabled={busy} onClick={()=>void exclusive(()=>processFile(file,undefined,true))}>إعادة فحص</button>}
    {['balance','opening'].includes(state?.kind||file.kind)&&!file.snapshotDate&&<button className="button secondary small" disabled={busy} onClick={()=>void stamp(file)}>تثبيت تاريخ الرصيد</button>}
    <button className="button secondary small" disabled={busy} onClick={()=>void remove(file)}><Trash2 size={14}/>حذف</button>
   </div></td></tr>;
  })}</tbody></table></div>{!loading&&!visible.length&&<p>لا توجد ملفات ضمن التصفية المختارة.</p>}
  </section>
  {opened&&<section className="panel"><h2>الملف المفتوح: <b dir="auto">{opened.file.name}</b></h2><p>معاينة أول 100 ألف حرف؛ التنزيل يسترجع الملف الأصلي كاملًا.</p><textarea readOnly dir="ltr" rows={12} style={{width:'100%'}} value={opened.text.slice(0,100000)}/></section>}
 </div>;
}
function SapPaste({disabled,onFile}:{disabled:boolean;onFile:(file:File)=>void}){
 const [text,T]=useState(''),[name,N]=useState('SAP.txt');
 return <div><label>اسم الكشف<input value={name} onChange={e=>N(e.target.value)} disabled={disabled}/></label><textarea rows={8} dir="ltr" style={{width:'100%'}} value={text} onChange={e=>T(e.target.value)} disabled={disabled}/><button className="button secondary" disabled={disabled||!text.trim()} onClick={()=>onFile(new File([text],/\.txt$/i.test(name)?name:name+'.txt',{type:'text/plain'}))}>حفظ الأصل ومعالجته</button></div>;
}
