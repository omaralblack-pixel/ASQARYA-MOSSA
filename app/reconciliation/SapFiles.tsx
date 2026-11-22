'use client';
import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {FileUp,RefreshCw,FileArchive,Download,Trash2,AlertTriangle,Copy} from 'lucide-react';
import {decodeLieutenantFile} from '../lib/lieutenant-file';
import {classifySapFile,sapKinds,type SapKind,type SapJob} from '../lib/sap-processing';
import {maxSapFileBytes,readSavedSapImport,saveSapImport} from '../lib/saved-sap-import';
import {listSapFiles,readSapArchive,readSapJson,sapRequest,sapFetch,type SapArchiveFile} from '../lib/sap-files-client';
import {fromSapStorageFilename} from '../lib/sap-archive-filename';
import {parseLieutenantTransfers} from '../lib/lieutenant';
import {isUnifiedSapSource,splitUnifiedSapSource,unifiedSapQuery} from '../lib/unified-sap-query';
import {splitSapSectionIntoChunks,type UnifiedChunkKind} from '../lib/sap-unified-chunks';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const uploadDay=(date:string)=>date&&Number.isFinite(Date.parse(date))?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date)):'';
const uploadTime=(date:string)=>date&&Number.isFinite(Date.parse(date))?uploadDay(date)+' '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Amman',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(date)):'';
type ActiveSapSnapshot={key:string;created:string;committed:string;documents:number;activeCount:number};
const statusNames={complete:'مكتمل',review:'اكتملت الدفعات — بحاجة مراجعة',archived:'محفوظ — نوع غير معروف',pending:'بانتظار الاستكمال',running:'قيد المعالجة',failed:'دفعات فاشلة — يمكن استكمالها'};
/** Prove uploaded immutable bytes are retrievable before starting any D1 job.
 * Exact comparison runs in the browser, outside the CPU-limited Worker. */
async function verifyArchivedSource(key:string,original:ArrayBuffer){
 const res=await sapFetch('/api/lieutenant-files?key='+encodeURIComponent(key),{cache:'no-store'});
 if(!res.ok)throw Error('الخادم أعاد مفتاح ملف، لكن تعذّر استرجاع الأصل من Supabase (HTTP '+res.status+'). لا يمكن تأكيد حفظ الملف.');
 const returned=await res.arrayBuffer();
 const a=new Uint8Array(original),b=new Uint8Array(returned);
 if(a.length!==b.length||!a.every((v,i)=>v===b[i]))
  throw Error('الملف المسترجع من Supabase لا يطابق الملف الأصلي. أوقفت المعالجة لحماية البيانات.');
}

export default function SapFiles({syncVersion=0,syncScope='all'}:{syncVersion?:number;syncScope?:string}){
 const [files,F]=useState<SapArchiveFile[]>([]),[jobs,J]=useState<Record<string,SapJob>>({}),[job,SJ]=useState<SapJob|null>(null);
 const [kind,K]=useState<SapKind>('unified'),[date,D]=useState(today()),[busy,B]=useState(false),[loading,L]=useState(true),[error,E]=useState(''),[message,M]=useState('');
 const [query,Q]=useState(''),[filter,FL]=useState('all'),[balanceFrom,BF]=useState(''),[balanceTo,BT]=useState(''),[uploadFrom,UF]=useState(''),[uploadTo,UT]=useState('');
 const [opened,OPEN]=useState<{file:SapArchiveFile;text:string}|null>(null);
 const [olderSnapshotNotice,OSN]=useState('');
  const [activeSnapshot,AS]=useState<ActiveSapSnapshot|null>(null),[snapshotError,SE]=useState('');
 const [fromDate,FROM]=useState(()=>today().slice(0,8)+'01'),[toDate,TO]=useState(today());
 const queryRef=useRef<HTMLTextAreaElement>(null);
 const lock=useRef(false),mounted=useRef(true);
 const lastSync=useRef(syncVersion);
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
   {kind:'opening',body:sections.opening,date:sections.from,count:sections.counts.OPENING},
   {kind:'balance',body:sections.closing,date:sections.to,count:sections.counts.CLOSING},
  ] as const;
  for(const part of parts){
   if(!part.count)continue;
   const name=file.name.replace(/\.[^.]+$/,'')+'-'+part.kind+'-'+(part.date||sections.from+'-'+sections.to)+'.txt';
   const res=await sapFetch('/api/lieutenant-files',{method:'POST',headers:{'Content-Type':'text/plain',
    'X-File-Name':encodeURIComponent(name),'X-File-Kind':part.kind,'X-Snapshot-Date':part.date},
    body:new TextEncoder().encode(part.body)});
   const stored=await readSapJson<{key:string}>(res,'أرشفة جزء '+part.kind+' من ملف SAP الموحد');
   if(!stored.key)throw Error('خادم الأرشيف لم يؤكد حفظ جزء '+part.kind+'؛ الملف الأصلي محفوظ.');
  }
 }

 const remember=(value:SapJob)=>{if(!mounted.current)return;SJ(value);J(old=>({...old,[value.key]:value}));};
 async function refresh(preferredKey?:string){
  const [archive,processing,snapshot]=await Promise.allSettled([
    listSapFiles(),sapRequest<{jobs:SapJob[]}>('/api/sap-processing'),
    sapRequest<{snapshot:ActiveSapSnapshot|null}>('/api/sap-snapshot'),
   ]);
  if(!mounted.current)return;
  if(archive.status==='fulfilled')F(archive.value);
   if(snapshot.status==='fulfilled'){AS(snapshot.value.snapshot);SE('');}
   else{AS(null);SE(snapshot.reason instanceof Error?snapshot.reason.message:'تعذّر قراءة النسخة الفعّالة من D1.');}
  if(processing.status==='fulfilled'){
   J(Object.fromEntries(processing.value.jobs.map(x=>[x.key,x])));
   const selected=preferredKey||job?.key||processing.value.jobs[0]?.key;
   if(selected){const result=await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(selected));if(result.job)remember(result.job);}
  }
  const failures=[archive,processing].filter((x):x is PromiseRejectedResult=>x.status==='rejected');
  if(failures.length)throw Error(failures.map(x=>x.reason instanceof Error?x.reason.message:String(x.reason)).join(' '));
 }
 useEffect(()=>{mounted.current=true;void refresh().catch(e=>E(e.message)).finally(()=>L(false));return()=>{mounted.current=false};},[]);
 useEffect(()=>{
   if(lastSync.current===syncVersion)return;
   lastSync.current=syncVersion;
   if((syncScope==='sap'||syncScope==='all')&&!lock.current)
     void refresh().catch(cause=>E(cause instanceof Error?cause.message:'تعذّر تحديث أرشيف SAP.'));
 },[syncVersion,syncScope]);
 async function exclusive(action:()=>Promise<void>){
  if(lock.current)return;lock.current=true;B(true);E('');M('');
  try{await action();}catch(e){if(mounted.current)E(e instanceof Error?e.message:'تعذّر إتمام الطلب.');}
  finally{lock.current=false;if(mounted.current)B(false);}
 }
 async function verifyActiveSnapshot(key:string,expected:number){
  const result=await sapRequest<{snapshot:ActiveSapSnapshot|null}>('/api/sap-snapshot');
  const snapshot=result.snapshot;
  if(!snapshot||snapshot.key!==key||snapshot.documents!==expected||
     snapshot.activeCount!==expected)
   throw Error('تم طلب اعتماد SAP، لكن سجل D1 لم يؤكد عدد الترحيلات. لا تعِد رفع الأصل؛ راجع النسخة المعتمدة.');
  AS(snapshot);SE('');
 }
 async function publishShared(file:SapArchiveFile,text:string){
  const sourceKind=classifySapFile(text);
  if(sourceKind!=='transfers'&&sourceKind!=='unified')return;
  const sharedText=sourceKind==='unified'?splitUnifiedSapSource(text).transfers:text;
  if(!parseLieutenantTransfers(sharedText,[]).transfers.length)return;
  const previous=await readSavedSapImport();
  if(previous?.text===sharedText)return;
  await saveSapImport({name:file.name,text:sharedText});
 }
 async function processUnifiedFile(file:SapArchiveFile,text:string):Promise<void>{
  // Avoid the CPU-limited monolithic Supabase parse (HTTP 546).
  const sections=splitUnifiedSapSource(text);
  // Verify the live pointer just once for the entire import. Repeating a
  // COUNT over all active transfers for every chunk would exhaust D1 reads.
  const active=(await sapRequest<{snapshot:ActiveSapSnapshot|null}>('/api/sap-snapshot')).snapshot;
  if(active&&active.activeCount!==active.documents)
   throw Error('عدد ترحيلات النسخة المعتمدة لا يطابق سجلها. أوقفت التحديث لحماية المطابقات.');
  if(active?.key===file.key){M('هذا الكشف معتمد فعلًا وجميع ترحيلاته مثبتة؛ لا يلزم تكرار المعالجة.');return;}
  const sources:{kind:UnifiedChunkKind;body:string;count:number;label:string}[]=[
   {kind:'transfers',body:sections.transfers,count:sections.counts.TRANSFER,label:'الترحيلات'},
   {kind:'official',body:sections.official,count:sections.counts.OFFICIAL,label:'المستندات الرسمية'},
   {kind:'journal',body:sections.journal,count:sections.counts.OINM,label:'حركات المخزون'},
  ];
  const parts=sources.filter(x=>x.count>0).map(x=>({...x,chunks:splitSapSectionIntoChunks(x.body,x.kind)}));
  const total=parts.reduce((n,x)=>n+x.chunks.length,0);
  const hash=file.key.split('__')[1];
  if(!/^[a-f0-9]{32}$/.test(hash))throw Error('بصمة أصل SAP غير صالحة.');
  let finished=0,review=0,reused=0;
  const transferKeys:string[]=[];
  for(const part of parts)for(let i=0;i<part.chunks.length;i++){
   if(!mounted.current)return;
   const name='sap-'+hash+'-'+part.kind+'-'+String(i+1).padStart(4,'0')+
    '-of-'+String(part.chunks.length).padStart(4,'0')+'.txt';
   const bytes=new TextEncoder().encode(part.chunks[i]);
   M('معالجة SAP المجزأة: '+(finished+1)+' من '+total+' — '+part.label+
    '. النسخ والدفعات السابقة محفوظة.');
   const response=await sapFetch('/api/lieutenant-files',{method:'POST',headers:{
    'Content-Type':'text/plain','X-File-Name':encodeURIComponent(name),
    'X-File-Kind':part.kind==='transfers'?'transfers':'other'
   },body:bytes});
   const saved=await readSapJson<{key:string}>(response,'أرشفة جزء SAP رقم '+(finished+1));
   if(!saved.key)throw Error('الخادم لم يؤكد أرشفة الجزء '+(finished+1));
   if(part.kind==='transfers')transferKeys.push(saved.key);
   await verifyArchivedSource(saved.key,bytes.buffer as ArrayBuffer);
   // Reuse only exact, already-approved source bytes. The server rehashes
   // this archived part and atomically copies the verified active rows.
   // Any new, altered or ambiguous part follows the existing full importer.
   if(part.kind==='transfers'){
    const check=await sapRequest<{reused:boolean;staged?:number}>('/api/sap-snapshot',{
     action:'reuse',key:file.key,child:saved.key,
    });
    if(check.reused){reused++;finished++;continue;}
   }
   const child:SapArchiveFile={key:saved.key,name,
    kind:part.kind==='transfers'?'transfers':'other',
    created:new Date().toISOString(),size:bytes.byteLength};
   await processFile(child,part.chunks[i],false,true);
   const status=(await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(child.key))).job;
   if(!status||!['complete','review','archived'].includes(status.status))
    throw Error('توقفت معالجة الجزء '+(finished+1)+' من '+total+
     '؛ المكتمل محفوظ. اضغط «حالة / استكمال» على الأصل لاستكمال الباقي.');
   if(status.status==='review')review++;
   if(part.kind==='transfers')await sapRequest('/api/sap-snapshot',{action:'stage',key:file.key,child:child.key});
   finished++;
  }
  // Never publish an individual chunk to the shared SAP full-export view.
  if(review)throw Error('اكتملت الدفعات مع أخطاء قراءة؛ راجعها قبل استبدال النسخة السابقة.');
  await archiveUnifiedParts(file,text);
  await sapRequest<{deleted:number}>('/api/sap-snapshot',{
   key:file.key,children:transferKeys,documents:parseLieutenantTransfers(sections.transfers,[]).transfers.length,
  });
  await verifyActiveSnapshot(file.key,parseLieutenantTransfers(sections.transfers,[]).transfers.length);
  await publishShared(file,text);
  M('اكتملت معالجة الملف الكبير على '+total+' أجزاء مستقلة.'+
   (reused?' أُعيد استخدام '+reused+' جزء مطابق من النسخة السابقة دون معالجته مجددًا.':'')+
   (review?' توجد ملاحظات قراءة في '+review+' أجزاء.':' جميع الدفعات ناجحة.')+
   ' تم تفعيل النسخة الجديدة مع الاحتفاظ بالأصول والنسخة السابقة للرجوع.');
 }
 async function processFile(file:SapArchiveFile,text?:string,recheck=false,fromUnified=false):Promise<void>{
  const current=await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(file.key));
  let state=current.job;
  if(!fromUnified&&(file.kind==='unified'||file.kind==='other')){
   const source=text??await readSapArchive(file);
   if(isUnifiedSapSource(source))return processUnifiedFile(file,source);
  }
  // Reuse D1 job state; a 1/3 import must never be restarted from the
  // expensive full Excel parsing path.
  const mayRecheck=!!state&&recheck&&state.done===state.total&&
   state.running===0&&state.kind!=='unified';
  if(!state||mayRecheck){
   const source=text??await readSapArchive(file);
   state=(await sapRequest<{job:SapJob}>('/api/sap-processing',{
    action:'start',key:file.key,text:source,recheck:mayRecheck,
   })).job;
  }
  const archiveKind=['transfers','balance','opening','unified'].includes(state.kind)?state.kind:'other';
  if(file.kind!==archiveKind&&!(file.kind==='other'&&state.kind==='unified')){
   const raw=await sapFetch('/api/lieutenant-files?key='+encodeURIComponent(file.key));
   if(!raw.ok)throw Error('تعذّر فتح الأصل لتصحيح تصنيفه.');
   const copied=await sapFetch('/api/lieutenant-files',{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name),'X-File-Kind':archiveKind},body:await raw.arrayBuffer()});
   const result=await readSapJson<{key:string}>(copied,'تصنيف ملف SAP المحفوظ');
   if(!result.key)throw Error('لم يؤكد الخادم حفظ النسخة المصنفة.');
   await refresh();
   return processFile({...file,key:result.key,kind:archiveKind,snapshotDate:''},text);
  }
  remember(state);
  // Unified imports are already preserved as immutable originals and D1 receipts.
  // Never replace the legacy shared full export with a shorter date-window subset.

  // Only unfinished batches are requested. Finished batches survive reloads and
  // independent tabs; the server lease serializes claims for the same batch.
  for(const batch of state.batches.filter(x=>x.state!=='complete')){
   if(!mounted.current)return;
   const result=await sapRequest<{job:SapJob;busy?:boolean}>('/api/sap-processing',{action:'batch',key:file.key,index:batch.idx});
   state=result.job;remember(state);
   if(result.busy){M('هناك طلب يعالج هذه الدفعة. حدّث الحالة أو استكمل بعد انتهاء الطلب؛ لن تتكرر المستندات.');return;}
   if(state.batches.find(x=>x.idx===batch.idx)?.state==='failed'){E('توقفت المعالجة عند دفعة فاشلة. الدفعات الناجحة محفوظة؛ اضغط «استكمال / إعادة محاولة» بعد مراجعة الخطأ.');return;}
  }
  // A temporary Supabase 503 must not prevent already-archived SAP batches
  // from being processed or resumed. Preserve derived-snapshot warnings separately.
  let archiveWarning='';
  if(state.kind==='unified'){
   try{await archiveUnifiedParts(file,text??await readSapArchive(file))}
   catch(e){archiveWarning=' تعذّر أرشفة أحد الأجزاء المشتقة: '+(e instanceof Error?e.message:'خطأ غير معروف')+'؛ يبقى الملف الأصلي محفوظًا.';}
  }
  if(state.kind==='transfers'&&!fromUnified&&state.status==='complete'){
   await sapRequest('/api/sap-snapshot',{action:'stage',key:file.key,child:file.key});
   await sapRequest('/api/sap-snapshot',{key:file.key,children:[file.key],documents:state.documents.length});
   await verifyActiveSnapshot(file.key,state.documents.length);
   await publishShared(file,text??await readSapArchive(file));
  }
  M((state.status==='complete'&&state.count>0?'اكتملت معالجة السجلات المثبتة.':state.status==='archived'?'الأصل مؤرشف فقط؛ لم يُثبت اعتماد بياناته.':state.status==='review'?'تحتاج البيانات مراجعة؛ لا يؤكد عدّاد الدفعات اعتمادها.':'المعالجة غير مكتملة.')+archiveWarning);
 }
 async function upload(event:ChangeEvent<HTMLInputElement>){
  const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(!file)return;
  await exclusive(async()=>{
   if(!file.size||file.size>maxSapFileBytes)throw Error('اختر ملفًا بحجم من 1 بايت إلى 16 ميغابايت.');
   OSN('');
   const bytes=await file.arrayBuffer();let text='',detected:SapKind='other',issue='';
   try{text=decodeLieutenantFile(bytes,file.name);detected=classifySapFile(text);}catch(e){issue=e instanceof Error?e.message:'تعذّر قراءة الملف.';}
   const needsDate=detected==='balance'||detected==='opening';
   if(needsDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today()||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))throw Error('اختر تاريخ الرصيد الفعلي الصحيح قبل الرفع.');
   const archiveKind=['transfers','balance','opening','unified'].includes(detected)?detected:'other';
   const res=await sapFetch('/api/lieutenant-files',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-File-Kind':archiveKind,'X-Snapshot-Date':needsDate?date:''},body:bytes});
   const saved=await readSapJson<{key:string}>(res,'حفظ الملف الأصلي في أرشيف SAP');
   if(!saved.key)throw Error('لم يؤكد الخادم حفظ الملف الأصلي.');
   // Save, verify and display the archive before any CPU-heavy processing.
   await verifyArchivedSource(saved.key,bytes);
   // Same filename is expected for daily SAP exports. Immutable source hashes,
   // document receipts and unique transfer numbers prevent duplicate imports.
   // Keep older incomplete jobs available for recovery without blocking today.
   const olderPartial=Object.values(jobs).filter(row=>
    row.done<row.total&&row.key!==saved.key&&fromSapStorageFilename(row.key.split('__').at(-1)||'')===file.name);
   if(olderPartial.length)OSN('تم قبول نسخة SAP الأحدث رغم وجود '+olderPartial.length+
    ' معالجة سابقة غير مكتملة بالاسم نفسه. النسخ القديمة محفوظة ويمكن استكمالها من الأرشيف، ولن تُعاد الدفعات المكتملة.');
   const stored:SapArchiveFile={key:saved.key,name:file.name,kind:archiveKind,
    created:new Date().toISOString(),snapshotDate:needsDate?date:'',size:file.size};
   F(prev=>[stored,...prev.filter(item=>item.key!==stored.key)]);
   K(detected);
   OPEN({file:stored,text});
   M('تم حفظ الأصل والتحقق من مطابقته في Supabase: '+file.name+'. المعالجة خطوة مستقلة.');
   if(!text){E('الأصل محفوظ ومؤكد؛ تعذّر قراءة محتواه: '+issue);return;}
   try{await processFile(stored,text)}
   finally{
    await refresh(stored.key).catch(e=>E('الأصل محفوظ ومؤكد، لكن تحديث المعالجة/قائمة الأرشيف فشل: '+(e instanceof Error?e.message:'خطأ غير معروف')));
   }
  });
 }
 async function stamp(file:SapArchiveFile){
  await exclusive(async()=>{
   const text=await readSapArchive(file),actual=classifySapFile(text);
   if(actual!=='balance'&&actual!=='opening')throw Error('هذا الملف ليس كشف رصيد معروفًا.');
   if(!date||date>today()||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('اختر تاريخ الرصيد الصحيح أعلى الصفحة.');
   if(!confirm('هل هذا الكشف يمثل '+(actual==='opening'?'الرصيد قبل أول حركة بتاريخ ':'الرصيد بنهاية يوم ')+date+'؟ ستُحفظ نسخة مؤرخة ويبقى الأصل.'))return;
   const raw=await sapFetch('/api/lieutenant-files?key='+encodeURIComponent(file.key));if(!raw.ok)throw Error('تعذّر قراءة الأصل.');
   const saved=await sapFetch('/api/lieutenant-files',{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name),'X-File-Kind':actual,'X-Snapshot-Date':date},body:await raw.arrayBuffer()});
   const out=await readSapJson<{key:string}>(saved,'تثبيت تاريخ رصيد 011');
   if(!out.key)throw Error('لم يؤكد الخادم تاريخ الرصيد.');
   await processFile({...file,key:out.key,snapshotDate:date},text);await refresh();
  });
 }
 async function remove(file:SapArchiveFile){
  if(!confirm('حذف الملف الأصلي «'+file.name+'» من الأرشيف نهائيًا؟ لن تُحذف المطابقات أو قرارات الإلغاء أو المستندات المعالجة.'))return;
  await exclusive(async()=>{
   const res=await sapFetch('/api/lieutenant-files',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:file.key})});
   const out=await readSapJson<{deleted?:boolean}>(res,'حذف الملف المحدد من أرشيف SAP');
   if(!out.deleted)throw Error('لم يؤكد الخادم الحذف.');
   if(opened?.file.key===file.key)OPEN(null);await refresh();M('حُذف الملف المحدد من الأرشيف.');
  });
 }
 async function verifyUnlistedOriginal(source:SapJob){
  const match=source.key.match(/^lieutenant\/(transfers|opening|balance|unified|other)__([a-f0-9]{32})__(?:(\d{4}-\d{2}-\d{2})__)?(.+)$/);
  if(!match)throw Error('مفتاح سجل المعالجة غير صالح.');
  const response=await sapFetch('/api/lieutenant-files?key='+encodeURIComponent(source.key),{cache:'no-store'});
  if(response.status===404)throw Error('يوجد سجل معالجة في D1 ('+source.done+'/'+source.total+
   ') لكن أصل الملف غير موجود في Supabase. أعد رفع نفس الأصل بالاسم نفسه لاستعادة الأرشيف، بدون حذف سجل المعالجة.');
  if(!response.ok)throw Error('تعذّر التأكد من أصل SAP في Supabase: HTTP '+response.status+'. لم أعتبر الملف مفقودًا.');
  const bytes=await response.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash.slice(0,32)!==match[2])throw Error('بصمة أصل SAP لا تطابق مفتاح سجل D1؛ أوقفت الاستكمال.');
  const restored:SapArchiveFile={key:source.key,name:fromSapStorageFilename(match[4]),kind:match[1],
   snapshotDate:match[3]||'',created:source.updated,size:bytes.byteLength};
  F(prev=>[restored,...prev.filter(file=>file.key!==restored.key)]);
  M('تم التحقق من وجود ملف SAP وسلامة بصمته في Supabase: '+restored.name+'. يمكن فتحه واستكمال دفعاته.');
 }
 const selectedJobFile=job?files.find(file=>file.key===job.key):undefined;
 const archiveUnlistedJobs=Object.values(jobs).filter(row=>!files.some(file=>file.key===row.key));
 const orphanActive=archiveUnlistedJobs.filter(row=>row.done<row.total);
 const orphanHistory=archiveUnlistedJobs.filter(row=>row.done>=row.total);
 const visible=files.filter(file=>{
  const actual=jobs[file.key]?.kind||file.kind,uploaded=uploadDay(file.created),snapshot=file.snapshotDate||'';
  return (!query||(file.name+' '+sapKinds[actual as SapKind]).toLowerCase().includes(query.trim().toLowerCase()))&&
   (filter==='all'||actual===filter)&&(!balanceFrom||!!snapshot&&snapshot>=balanceFrom)&&(!balanceTo||!!snapshot&&snapshot<=balanceTo)&&(!uploadFrom||uploaded>=uploadFrom)&&(!uploadTo||uploaded<=uploadTo);
 });
 return <div className="sap-files">
  <div className="page-title"><div><p className="eyebrow">إدارة المؤسسة · المصدر المشترك</p><h1>ملفات SAP</h1><p>ارفع ملف SAP الكامل كل يوم. بعد اكتمال المعالجة والتحقق من D1 تُفعّل النسخة الجديدة، مع الاحتفاظ بالأصول والنسخة السابقة والمطابقات والتصحيحات اليدوية.</p></div><FileArchive size={32}/></div>
  <section className="panel"><h2>رفع ملف SAP جديد</h2><div className="table-controls">
   <label>نوع الملف المتوقع (يُصحّح تلقائيًا)<select value={kind} disabled={busy} onChange={e=>K(e.target.value as SapKind)}>{Object.entries(sapKinds).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
   {kind!=='unified'&&<><label>تاريخ الرصيد الفعلي<input type="date" max={today()} value={date} disabled={busy} onChange={e=>D(e.target.value)}/></label>
   <label className="button primary sap-file-picker"><FileUp size={16}/>إرفاق وحفظ في قاعدة البيانات<input type="file" accept=".txt,.tsv,.csv,.xlsx" aria-label="رفع ملف SAP جديد" disabled={busy} onChange={upload}/></label></>}
  </div>{kind==='unified'&&<div className="sap-unified-query" aria-label="الكويري الشامل — SAP 011">
   <div className="sap-unified-query-top"><div><h3>الكويري الشامل — SAP 011</h3><p>استخرج الترحيلات والأرصدة والحركات ومستندات العقبة مرة واحدة.</p></div>
    <label>من تاريخ<input type="date" value={fromDate} max={today()} onChange={e=>FROM(e.target.value)}/></label>
    <label>إلى تاريخ<input type="date" value={toDate} max={today()} onChange={e=>TO(e.target.value)}/></label>
    <button type="button" className="button secondary" disabled={!unifiedSql} onClick={()=>void copyUnifiedSql()}><Copy size={15}/>نسخ الكويري الشامل فقط</button>
    <label className="button primary sap-file-picker"><FileUp size={15}/>رفع الملف الموحد<input type="file" accept=".txt,.tsv,.csv,.xlsx" aria-label="رفع الملف الموحد SAP" disabled={busy} onChange={upload}/></label>
   </div>
   <textarea ref={queryRef} aria-label="كويري SAP الشامل" dir="ltr" readOnly rows={4} value={unifiedSql} />
   {queryError&&<p className="red" role="alert">{queryError}</p>}
   <p className="hint">الكويري الشامل الوحيد جاهز للنسخ: رقم الفاتورة من OWTR.Comments، والملاحظات من OWTR.U_ST_Remarks، والفرع من OWTR.U_Branch. افتح نافذة SAP SQL جديدة وفارغة ثم الصق الكويري؛ لا تضف كويري CUFD أو أي SELECT آخر بعد ORDER BY.</p>
  </div>}<p className="hint">التاريخ مطلوب لكشوف الرصيد فقط: الختامي بنهاية اليوم، والافتتاحي قبل أول حركة في اليوم. تاريخ الرفع مستقل ولا يُستخدم بدل تاريخ الرصيد. التصنيف يعتمد الأعمدة الفعلية.</p>
  <details><summary>لصق كشف SAP بدل إرفاق ملف</summary><SapPaste disabled={busy} onFile={file=>{void upload({currentTarget:{files:[file],value:''}} as unknown as ChangeEvent<HTMLInputElement>);}}/></details>
  </section>
  <section className="panel" aria-label="حالة معالجة ملفات SAP"><div className="section-title"><h2>حالة التحديث والمعالجة</h2><button className="button secondary" disabled={busy||loading} onClick={()=>void exclusive(refresh)}><RefreshCw size={16}/>تحديث الحالة والأرشيف</button></div>
   {loading&&<p role="status">جارٍ قراءة الأرشيف والحالات المحفوظة…</p>}
   {busy&&<p role="status">جارٍ حفظ الملف أو معالجة الدفعات. يمكن استكمال الدفعات المحفوظة بعد تحديث الصفحة.</p>}
   {error&&<p className="banner error" role="alert"><AlertTriangle size={16}/>{error}</p>}{message&&<p className="banner info" role="status">{message}</p>}{olderSnapshotNotice&&<p className="hint" role="status">{olderSnapshotNotice}</p>}
    {snapshotError?<p className="banner warn" role="alert"><AlertTriangle size={16}/>تعذّر التحقق من الاعتماد الفعلي: {snapshotError}</p>:
     activeSnapshot?<div className={activeSnapshot.activeCount===activeSnapshot.documents?'banner info':'banner warn'} role="status">
       <strong>آخر نسخة SAP معتمدة فعليًا في D1</strong>
       <p>الأصل: <b dir="auto">{fromSapStorageFilename(activeSnapshot.key.split('__').at(-1)||'')}</b>
       {' '}· الرفع: {uploadTime(activeSnapshot.created)}
       {' '}· الاعتماد: {uploadTime(activeSnapshot.committed)}
       {' '}· الترحيلات المعتمدة: {activeSnapshot.activeCount} من {activeSnapshot.documents}</p>
       {activeSnapshot.activeCount!==activeSnapshot.documents&&<p>تنبيه: عدد سجلات الترحيلات الفعّالة لا يطابق إيصال الاعتماد؛ يلزم التدقيق قبل اعتبار البيانات مكتملة.</p>}
      </div>:
      !loading&&<p className="banner warn" role="status">لا يوجد إيصال اعتماد لنسخة SAP في D1. ظهور «مكتمل» في الأرشيف وحده لا يعني أن الترحيلات مفعّلة.</p>}
    {activeSnapshot&&files.some(file=>file.kind==='unified'&&file.key!==activeSnapshot.key&&file.created>activeSnapshot.created)&&
     <p className="banner warn" role="status">توجد نسخة SAP موحّدة أحدث في الأرشيف لم تُثبت كنسخة معتمدة. افحصها من القائمة أدناه.</p>}
   {job?<><p role="status"><b>{activeSnapshot?.key===job.key&&activeSnapshot.activeCount===activeSnapshot.documents?'معتمد فعليًا في D1':statusNames[job.status]}</b> · {job.total?job.done+' من '+job.total+' دفعة':'لا دفعات معالجة معلقة'} · {job.count} مستند/بند · وقت الدفعات: {(job.duration/1000).toFixed(2)} ثانية</p>
    {job.done<job.total&&<div className="banner info">
     <div>
      <strong dir="auto">{selectedJobFile?.name||fromSapStorageFilename(job.key.split('__').at(-1)||'')}</strong>
      {!busy&&<p>{job.running?'هناك دفعة مسجلة قيد التنفيذ؛ يمكن تحديث الحالة أو محاولة الاستكمال بعد انتهائها.':
       'المعالجة غير مكتملة. اضغط استكمال لتشغيل الدفعات المتبقية؛ تحديث الحالة يعرض التقدم فقط.'}
       {' '}الدفعات المكتملة محفوظة ولا تحتاج إعادة رفع الملف.</p>}
      <button type="button" className="button primary" disabled={busy||loading}
       onClick={()=>void exclusive(()=>selectedJobFile?processFile(selectedJobFile):verifyUnlistedOriginal(job))}>
       <RefreshCw size={16}/>{selectedJobFile?'استكمال الدفعات المتبقية ('+(job.total-job.done)+')':'تحقق من الأصل للاستكمال'}
      </button>
     </div>
    </div>}
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
  </div><p className="hint">{visible.length} من {files.length} ملفًا ظاهرًا في فهرس Supabase. سجلات معالجة D1 مستقلة عن الملفات الأصلية.</p>
  <div className="table-scroll"><table><thead><tr><th>الملف</th><th>النوع</th><th>تاريخ الرصيد</th><th>تاريخ الرفع</th><th>حالة المعالجة</th><th>الإجراءات</th></tr></thead><tbody>{visible.map(file=>{
   const state=jobs[file.key];return <tr key={file.key}><td dir="auto">{file.name}</td><td>{file.kind==='other'&&opened?.file.key===file.key&&isUnifiedSapSource(opened.text)?
     'الكويري الشامل — نسخة مؤرشفة قديمة':sapKinds[(state?.kind||file.kind) as SapKind]||file.kind}</td><td dir="ltr">{file.snapshotDate||'—'}</td><td dir="ltr">{uploadTime(file.created)}</td><td>{activeSnapshot?.key===file.key?
      (activeSnapshot.activeCount===activeSnapshot.documents?'معتمد فعليًا في D1 — '+activeSnapshot.documents+' ترحيل':'اعتماد مسجل — اختلاف في عدد الترحيلات'):
       state?(state.total===0?statusNames[state.status]+' — بلا دفعات معلقة':statusNames[state.status]+' ('+state.done+'/'+state.total+')'):
        ['balance','opening'].includes(file.kind)?'محفوظ كمرجع رصيد — دون دفعات':'لم تُسجّل معالجة'}{state?.failed?` · ${state.failed} فاشلة`:''}</td><td><div className="row-actions">
    <button className="button secondary small" disabled={busy} onClick={()=>void exclusive(async()=>{OPEN({file,text:await readSapArchive(file)});const result=await sapRequest<{job:SapJob|null}>('/api/sap-processing?key='+encodeURIComponent(file.key));SJ(result.job);})}>فتح</button>
    <a className="button secondary small" href={'/api/lieutenant-files?key='+encodeURIComponent(file.key)} download={file.name}><Download size={14}/>تنزيل</a>
    <button className="button secondary small" disabled={busy} onClick={()=>void exclusive(()=>processFile(file))}>{state?.status==='complete'?'تحقق من المعالجة':'حالة / استكمال'}</button>
    {state&&state.kind!=='unified'&&state.done===state.total&&<button className="button secondary small" disabled={busy} onClick={()=>void exclusive(()=>processFile(file,undefined,true))}>إعادة فحص</button>}
    {['balance','opening'].includes(state?.kind||file.kind)&&!file.snapshotDate&&<button className="button secondary small" disabled={busy} onClick={()=>void stamp(file)}>تثبيت تاريخ الرصيد</button>}
    <button className="button secondary small" disabled={busy||!!state&&state.done<state.total} title={state&&state.done<state.total?'يوجد دفعات SAP غير مكتملة؛ الأصل محمي من الحذف.':'حذف الأصل بعد التأكيد'} onClick={()=>void remove(file)}><Trash2 size={14}/>حذف</button>
   </div></td></tr>;
  })}</tbody></table></div>{!loading&&!visible.length&&<p>لا توجد ملفات ظاهرة ضمن التصفية. افحص سجلات المعالجة أدناه قبل إعادة الرفع.</p>}
   {archiveUnlistedJobs.length>0&&<div className="banner warn" role="status"><AlertTriangle size={17}/><div>
    <strong>{orphanActive.length} معالجة غير مكتملة بلا أصل ظاهر في Supabase؛ {orphanHistory.length} سجل تاريخي مكتمل أو بلا دفعات</strong>
    <p>الملفات ذات المعالجة غير المكتملة هي أولوية الاسترجاع. سجل D1 ليس إثباتًا أن الأصل محفوظ، ولا نربط الملفات بالاسم وحده.</p>
    {orphanActive.slice(0,20).map(row=><p key={row.key}>
     <b dir="auto">{fromSapStorageFilename(row.key.split('__').at(-1)||'')}</b> <small dir="ltr">({row.key.split('__')[1]?.slice(0,10)})</small> — {row.done} من {row.total} دفعة
     {' '}<button type="button" className="button secondary small" disabled={busy}
       onClick={()=>void exclusive(()=>verifyUnlistedOriginal(row))}>تحقق من الأصل</button>
    </p>)}
    {orphanHistory.length>0&&<details><summary>{orphanHistory.length} سجلات معالجة تاريخية — للعرض فقط</summary>
     {orphanHistory.map(row=><p key={row.key}><span dir="auto">{fromSapStorageFilename(row.key.split('__').at(-1)||'')}</span>
       {' '}<small dir="ltr">({row.key.split('__')[1]?.slice(0,10)})</small> — {row.done}/{row.total}</p>)}
    </details>}
   </div></div>}
  </section>
  {opened&&<section className="panel"><h2>الملف المفتوح: <b dir="auto">{opened.file.name}</b></h2><p>معاينة أول 100 ألف حرف؛ التنزيل يسترجع الملف الأصلي كاملًا.</p><textarea readOnly dir="ltr" rows={12} style={{width:'100%'}} value={opened.text.slice(0,100000)}/></section>}
 </div>;
}
function SapPaste({disabled,onFile}:{disabled:boolean;onFile:(file:File)=>void}){
 const [text,T]=useState(''),[name,N]=useState('SAP.txt');
 return <div><label>اسم الكشف<input value={name} onChange={e=>N(e.target.value)} disabled={disabled}/></label><textarea rows={8} dir="ltr" style={{width:'100%'}} value={text} onChange={e=>T(e.target.value)} disabled={disabled}/><button className="button secondary" disabled={disabled||!text.trim()} onClick={()=>onFile(new File([text],/\.txt$/i.test(name)?name:name+'.txt',{type:'text/plain'}))}>حفظ الأصل ومعالجته</button></div>;
}
