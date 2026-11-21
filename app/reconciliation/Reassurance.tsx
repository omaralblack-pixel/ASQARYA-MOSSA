'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {AlertTriangle,ArrowDownToLine,CheckCircle2,HeartPulse,Printer,RefreshCw,RotateCcw,Search,ShieldCheck} from 'lucide-react';
import {mapBounded,readAllRecords,readJson} from '../lib/bounded-read';
import {collectInvoicesByDate} from '../lib/invoice-collector';
import {readActiveSap} from '../lib/active-sap';
import {readSapArchive} from '../lib/sap-files-client';
import type {LieutenantTransfer} from '../lib/lieutenant';
import {restoreLieutenantSource,restoreLieutenantStock,restoreUnifiedStockSnapshots,type LieutenantSourceFile} from '../lib/lieutenant-source';
import {readSavedSapImport} from '../lib/saved-sap-import';
import {reassure,reassuranceSource,type ReassuranceData,type ReassuranceRecord,type ReassuranceReport,type ReassuranceStock,type ReassuranceState} from '../lib/reassurance';
import {digits,type Transfer} from '../lib/reconcile';
import {buildReassuranceCouncil,type ReassuranceCouncilControl,type ReassuranceCouncilFinding} from '../lib/reassurance-council';
import type {ColonelRecord} from '../lib/colonel-core';

const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Amman'});
const format=new Intl.NumberFormat('en-US',{maximumFractionDigits:6});
const quantity=(n:number|null)=>n===null?'—':format.format(n);
const labels:Record<ReassuranceState,string>={match:'مطابق',transfer:'نقص يحتاج تفسير',return:'زيادة تحتاج تفسير',review:'يحتاج تحقق'};
const badge=(state:ReassuranceState)=>state==='match'?'match':state==='review'?'review':'difference';
type Loaded={data:ReassuranceData;transfers:LieutenantTransfer[];sourceIssues:string[];sourceName:string;
  closing:ReassuranceStock|null;opening:ReassuranceStock|null;
  councilRecords:ColonelRecord[]|null;councilControls:ReassuranceCouncilControl[]|null;councilWarnings:string[]};

async function readAuditRecords(signal:AbortSignal,progress:(page:number)=>void):Promise<ReassuranceRecord[]>{
  return readAllRecords<ReassuranceRecord>(cursor=>{
    const params=new URLSearchParams({reassuranceRecords:'1'});
    if(cursor){params.set('afterUpdated',cursor.updated);params.set('afterId',cursor.id)}
    return readJson('/api/reconcile?'+params,signal);
  },progress);
}
async function readColonelControls(from:string,to:string,signal:AbortSignal):Promise<ReassuranceCouncilControl[]>{
  const periods:string[]=[];
  let month=from.slice(0,7);const end=to.slice(0,7);
  for(let i=0;month<=end&&i<14;i++){
    periods.push(month);
    const next=new Date(month+'-01T00:00:00Z');
    next.setUTCMonth(next.getUTCMonth()+1);
    month=next.toISOString().slice(0,7);
  }
  if(month<=end)throw Error('الفترة أطول من سنة؛ لا يمكن قراءة قرارات العقيد كاملة.');
  return mapBounded(periods,2,month=>readJson<ReassuranceCouncilControl>(
    '/api/colonel?month='+encodeURIComponent(month),signal));
}

export default function Reassurance({branches,onOpenRecord,onOpenTransfer,onNavigate,syncVersion=0,syncScope='all'}:{branches:string[];
  syncVersion?:number;syncScope?:string;
  onOpenRecord:(id:string)=>void;onOpenTransfer:(transfer:Transfer,branch:string)=>void;
  onNavigate:(view:'serial-soldier'|'lieutenant'|'colonel')=>void}){
  const [from,setFrom]=useState(()=>today().slice(0,8)+'01');
  const [to,setTo]=useState(today);
  const [loaded,setLoaded]=useState<Loaded|null>(null);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  const [stage,setStage]=useState('');
  const active=useRef<AbortController|null>(null);
  // Parent renders may recreate the array; scope depends on its values.
  const branchKey=JSON.stringify(branches);
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState('candidate');
  const [checkedAt,setCheckedAt]=useState('');
  const request=useRef(0);
  const lastArchiveCheck=useRef(0);
  const lastSync=useRef(syncVersion);
  const reloadRef=useRef<()=>Promise<void>>(async()=>{});
  const valid=!!from&&!!to&&from<=to&&to<=today();
  const report=useMemo<ReassuranceReport|null>(()=>loaded&&valid?reassure({...loaded,from,to}):null,[loaded,from,to,valid]);
  const council=useMemo(()=>{
    if(!loaded?.councilRecords||!loaded.councilControls||!valid)return null;
    return buildReassuranceCouncil({from,to,records:loaded.councilRecords,
      transfers:loaded.transfers,controls:loaded.councilControls,
      sourceReady:loaded.transfers.length>0&&!loaded.sourceIssues.length});
  },[loaded,from,to,valid]);
  const query=digits(search).trim().toLowerCase();
  const visible=report?.rows.filter(row=>
    (filter==='candidate'?row.candidates.length>0:
      filter==='all'||filter==='action'&&row.state!=='match'||row.state===filter)&&
    digits(row.code+' '+row.name+' '+row.candidates.map(doc=>doc.number).join(' ')).toLowerCase().includes(query))||[];
  const candidateCount=report?.rows.filter(row=>row.candidates.length>0).length||0;
  const transferLookup=/^\d{4,20}$/.test(query)?query:'';
  const matchedSettlements=transferLookup?report?.settlements.filter(item=>
    item.number.includes(transferLookup)||item.counterparts.some(number=>number.includes(transferLookup)))||[]:[];
  const openCandidate=(number:string)=>{
    const source=loaded?.transfers.find(item=>item.transfer.number===number);
    if(source)onOpenTransfer(source.transfer,source.branch);
  };
  const counts={match:0,transfer:0,return:0,review:0};
  for(const row of report?.rows||[])counts[row.state]++;

  async function reload(){
    lastArchiveCheck.current=Date.now();
    active.current?.abort(new Error('أُلغي الفحص السابق لبدء فحص أحدث.'));
    const controller=new AbortController();active.current=controller;
    const signal=controller.signal;
    const id=++request.current;
    const progress=(value:string)=>{if(id===request.current)setStage(value)};
    const deadline=setTimeout(()=>controller.abort(new Error('انتهت مهلة الفحص الإجمالية (3 دقائق). الفحص غير مكتمل؛ أعد المحاولة.')),180_000);
    setLoaded(null);setError('');setBusy(true);
    if(!valid){clearTimeout(deadline);active.current=null;setBusy(false);return;}
    try{
      progress('التحقق من نسخة البيانات المشتركة…');
      const revision=await readJson<{revision:number}>('/api/project-sync?limit=1',signal);
      if(!Number.isSafeInteger(revision.revision))throw Error('تعذّر التحقق من نسخة البيانات.');
      progress('قراءة الفواتير والأرشيف وقرارات العقيد…');
      const archive=async()=>{
        const files:LieutenantSourceFile[]=[];
        let page:number|null=0;
        const seen=new Set<number>();
        while(page!==null){
          if(!Number.isSafeInteger(page)||page<0||seen.size>=1000||seen.has(page))throw Error('تعذّر استكمال قائمة ملفات SAP. أعد الفحص.');
          seen.add(page);
          const next:{files:LieutenantSourceFile[];nextPage:number|null}=await readJson('/api/lieutenant-files?page='+page,signal);
          if(!Array.isArray(next.files)||!(next.nextPage===null||Number.isSafeInteger(next.nextPage)))throw Error('قائمة أرشيف SAP غير مكتملة.');
          files.push(...next.files);page=next.nextPage;
        }
        return files;
      };
      const [metaResult,filesResult,recordsResult,controlsResult,activeResult]=await Promise.allSettled([
        readJson<Pick<ReassuranceData,'reference'|'openingStock'>>('/api/reconcile?reassuranceMeta=1&from='+encodeURIComponent(from),signal),
        archive(),readAuditRecords(signal,page=>progress('قراءة الفواتير — الصفحة '+page)),readColonelControls(from,to,signal),
        readActiveSap(signal,page=>progress('قراءة SAP المعتمد في D1 — الصفحة '+page)),
      ]);
      signal.throwIfAborted();
      if(metaResult.status==='rejected')throw metaResult.reason;
      if(recordsResult.status==='rejected')throw recordsResult.reason;
      const data:ReassuranceData={...collectInvoicesByDate(recordsResult.value,from,to),
        ...metaResult.value,records:recordsResult.value};
      const files=filesResult.status==='fulfilled'?filesResult.value:[];
      let shared:Awaited<ReturnType<typeof readSavedSapImport>>;
      let sharedRead:ReturnType<typeof readSavedSapImport>|undefined;
      const readShared=()=>sharedRead??=(readSavedSapImport({signal}).then(value=>{shared=value;return value}));
      const sourceErrors:string[]=[];
      if(activeResult.status==='rejected')sourceErrors.push('تعذّر التحقق من مصدر SAP المعتمد في D1: '+(activeResult.reason instanceof Error?activeResult.reason.message:'خطأ قراءة'));
      const councilWarnings:string[]=[];
      if(controlsResult.status==='rejected')councilWarnings.push('تعذّر قراءة قرارات العقيد والملازم: '+
        (controlsResult.reason instanceof Error?controlsResult.reason.message:'خطأ غير معروف'));
      if(filesResult.status==='rejected')sourceErrors.push('تعذّر تحميل أرشيف كشوف 011. أعد المحاولة أو حدّث الكشوف من الملازم أول.');
      if(!Array.isArray(data.records)||!Array.isArray(data.reference)||!Array.isArray(data.openingStock))
        throw Error('خادم الفحص يحتاج آخر تحديث. أعد تحميل الصفحة بعد اكتمال النشر.');
      // Missing controls invalidate a confirmed match as well as the council.
      sourceErrors.push(...councilWarnings);
      progress('قراءة ملفات SAP والأرصدة المؤرخة 011…');
      const cache=new Map<string,Promise<string>>();
      const readArchive=(file:LieutenantSourceFile)=>{
        if(!cache.has(file.key))cache.set(file.key,(async()=>{
          signal.throwIfAborted();
          progress('قراءة مصدر SAP: '+file.name);
          return readSapArchive(file,{signal});
        })());
        return cache.get(file.key)!;
      };
      const [sourceResult,closingResult,openingResult]=await Promise.allSettled([
        activeResult.status==='fulfilled'?Promise.resolve({key:activeResult.value.snapshot.key,name:'SAP المعتمد فعليًا في D1 — '+activeResult.value.snapshot.documents+' ترحيل',
          scan:{transfers:activeResult.value.transfers,issues:activeResult.value.transfers.flatMap(row=>row.issues)}}):restoreLieutenantSource(files,branches,readArchive,readShared),
        restoreLieutenantStock(files,'balance',to,readArchive),
        restoreLieutenantStock(files,'opening',from,readArchive),
      ]);
      const source=sourceResult.status==='fulfilled'?sourceResult.value:null;
      const closing=closingResult.status==='fulfilled'?closingResult.value:null;
      const opening=openingResult.status==='fulfilled'?openingResult.value:null;
      // A verified unified original can supply stock even when publishing the
      // optional separate opening/closing archive copies failed.
      let unifiedStock:Awaited<ReturnType<typeof restoreUnifiedStockSnapshots>>|null=null;
      if((!closing||!opening)&&files.some(file=>file.kind==='unified'||file.kind==='other')){
        try{unifiedStock=await restoreUnifiedStockSnapshots(files,from,to,readArchive)}
        catch(cause){sourceErrors.push('تعذّر استخراج رصيد 011 من الملف الشامل: '+(cause instanceof Error?cause.message:'خطأ غير معروف'))}
      }
      const actualClosing=closing||unifiedStock?.closing;
      const actualOpening=opening||unifiedStock?.opening;
      if(sourceResult.status==='rejected')sourceErrors.push('تعذّر فتح كشف الترحيلات من الأرشيف.');
      if(closingResult.status==='rejected'&&!actualClosing)sourceErrors.push('تعذّر فتح كشف رصيد 011 الفعلي.');
      if(openingResult.status==='rejected'&&!actualOpening)sourceErrors.push('تعذّر فتح كشف الرصيد الافتتاحي.');
      signal.throwIfAborted();
      const latest=await readJson<{revision:number}>('/api/project-sync?limit=1',signal);
      if(latest.revision!==revision.revision)throw Error('تغيّرت البيانات أثناء الفحص. أعد المحاولة لقراءة نسخة متزامنة كاملة.');
      const {scan,name:sourceName}=reassuranceSource(source,shared,branches);
      if(id!==request.current)return;
      setLoaded({data,transfers:scan?.transfers||[],sourceIssues:[
        ...sourceErrors,...(!actualClosing||!actualOpening?unifiedStock?.issues||[]:[]),
        ...(scan?.issues||[]),
      ],sourceName,
        closing:actualClosing?{date:actualClosing.file.snapshotDate!,...actualClosing.stock}:null,
        opening:actualOpening?{date:actualOpening.file.snapshotDate!,...actualOpening.stock}:null,
        councilRecords:recordsResult.status==='fulfilled'?recordsResult.value:null,
        councilControls:controlsResult.status==='fulfilled'?controlsResult.value:null,
        councilWarnings});
      setCheckedAt(new Date().toLocaleTimeString('ar-JO',{timeZone:'Asia/Amman',hour:'2-digit',minute:'2-digit'}));
    }catch(cause){if(id===request.current)setError(cause instanceof Error?cause.message:'تعذّر إجراء الفحص.');}
    finally{clearTimeout(deadline);if(id===request.current){setBusy(false);active.current=null;}}
  }
  useEffect(()=>{reloadRef.current=reload;});
  useEffect(()=>{
    if(lastSync.current===syncVersion)return;
    lastSync.current=syncVersion;
    if(['reconcile','colonel','sap','all'].includes(syncScope))void reloadRef.current();
  },[syncVersion,syncScope]);
  useEffect(()=>{void reloadRef.current();return()=>{request.current++;active.current?.abort(new Error('أُلغي الفحص السابق.'));active.current=null;};},[from,to,branchKey]); // Read-only; refreshes on screen opening and date changes.
  useEffect(()=>{
    const syncOnReturn=()=>{
      // Another tab or the lieutenant may have uploaded a newer immutable SAP
      // source while this tab was inactive. Recheck when the user returns.
      if(document.visibilityState==='visible'&&Date.now()-lastArchiveCheck.current>30_000&&!active.current)
        void reloadRef.current();
    };
    window.addEventListener('focus',syncOnReturn);
    document.addEventListener('visibilitychange',syncOnReturn);
    return ()=>{
      window.removeEventListener('focus',syncOnReturn);
      document.removeEventListener('visibilitychange',syncOnReturn);
    };
  },[]);

  const settled=report?.state==='match';
  const crossChecked=!!council&&!loaded?.councilWarnings.length;
  const councilFindings=council?.findings||[];
  const sourceMeta=[
    {id:'soldier',name:'الجندي السيريل',view:'serial-soldier' as const,
      detail:council?'فواتير '+council.soldier.invoices+' · ورق غير مؤكد '+council.soldier.paperPending+
        ' · تكرار '+council.soldier.duplicates+
        ' · ربط غير محسوم '+council.soldier.unlinked:'سجل الجندي غير متاح'},
    {id:'lieutenant',name:'الملازم أول',view:'lieutenant' as const,
      detail:council?'حركات SAP '+council.lieutenant.transfers+' · عكسي مسوّى '+council.lieutenant.reversed+
        ' · كاش فان مفتوح '+council.lieutenant.cashVanPending:'حالة رقابة SAP غير متاحة'},
    {id:'colonel',name:'العقيد',view:'colonel' as const,
      detail:council?'أيام جاهزة '+council.colonel.readyDays+'/'+council.colonel.invoiceDays+
        ' · ترحيلات مفتوحة '+council.colonel.openTransfers:'رقابة أيام العقيد غير متاحة'},
  ];
  const openCouncilFinding=(finding:ReassuranceCouncilFinding)=>{
    if(finding.recordId){onOpenRecord(finding.recordId);return}
    if(finding.transferNo){
      const source=loaded?.transfers.find(item=>item.transfer.number===finding.transferNo);
      if(source){onOpenTransfer(source.transfer,source.branch);return}
    }
    onNavigate(finding.source==='soldier'?'serial-soldier':finding.source==='lieutenant'?'lieutenant':'colonel');
  };
  const closingUnavailable=!!report&&(!loaded?.closing||loaded.closing.date!==to);
  return <div className="reassurance-screen">
    <div className="page-title"><div><p className="eyebrow">الفواتير × المستودع 011</p><h1><HeartPulse size={30}/> طمني</h1><p>افحص الفرق، وشوف الترحيل المحدد الذي قد يفسّره بالكامل. لا يُقترح إلغاء مستند بناءً على تطابق كمية صنف واحد فقط.</p></div>
      <div className="save-actions no-print"><button type="button" className="button secondary" disabled={busy||!report} onClick={()=>window.print()}><Printer size={16}/>طباعة النتيجة</button>
      <button type="button" className="button primary" disabled={busy||!valid} onClick={()=>void reload()}><RefreshCw size={17} className={busy?'reassurance-spin':''}/>طمني الآن</button></div></div>
    <section className="panel reassurance-dates"><div className="form-grid">
      <label>الفواتير والافتتاحي من تاريخ<input type="date" value={from} max={to||today()} onChange={event=>setFrom(event.target.value)}/></label>
      <label>الفحص ورصيد 011 حتى نهاية<input type="date" value={to} min={from} max={today()} onChange={event=>setTo(event.target.value)}/></label>
    </div><p className="hint">المتوقع في 011 = الافتتاحي + كميات الفواتير في الفترة. الفرق = رصيد SAP الفعلي − المتوقع. كل الكميات بالحبة، بعد تحويل الوحدات المعتمدة.</p>
    {!valid&&<p role="alert" className="banner error">اختر فترة صحيحة تنتهي اليوم أو قبله.</p>}</section>
    {busy&&<section className="panel reassurance-loading" role="status"><RefreshCw size={28} className="reassurance-spin"/><b>بفحص الفواتير ورصيد 011…</b><p>{stage}</p></section>}
    {error&&<div className="banner error" role="alert">{error}<p>تعذّر إكمال الفحص؛ لا توجد نتيجة مطابقة مؤكدة.</p><button type="button" className="button secondary" disabled={busy||!valid} onClick={()=>void reload()}>إعادة المحاولة</button></div>}
    {!busy&&report&&<>
      <section className={'reassurance-summary '+(settled?'is-matched':'needs-action')} role="status">
        {settled?<CheckCircle2 size={38}/>:<AlertTriangle size={38}/>}
        <div><h2>{settled&&crossChecked&&councilFindings.length===0?'كميات 011 مطابقة حسب المصادر المحفوظة':
          settled?'الرصيد مطابق، لكن باقي مصادر الرقابة تحتاج تحقق':
          report.state==='review'?'في بيانات بدها تحقق':'في فروقات بدها متابعة'}</h2>
        <p>{settled?'الكميات متطابقة حسب SAP والفواتير المحفوظة. لا يُعد ذلك تأكيدًا لوصول كشف سجى غير المحفوظ في المشروع.':
          closingUnavailable?'رصيد 011 الفعلي غير متاح بتاريخ الفحص؛ لا يمكن تحديد عدد الترحيلات أو المرتجعات بعد. '+counts.review+' صنف ينتظر التحقق.':
          `${candidateCount} صنف له ترحيل مرشح للفحص · ${counts.transfer+counts.return+counts.review} صنف غير محسوم (لا يعني وجود ترحيل يجب إلغاؤه)`}</p>
        <small>الفترة <b dir="ltr">{from} — {to}</b> · {report.invoiceCount} فاتورة · آخر فحص {checkedAt}</small></div>
      </section>
      <div className="stats reassurance-stats"><button type="button" className={'stat '+(filter==='candidate'?'selected':'')}
        onClick={()=>setFilter('candidate')} aria-pressed={filter==='candidate'}><Search size={20}/><span>ترحيلات مرشحة للفحص</span><strong>{candidateCount}</strong></button>{([
        ['match','مطابقة',CheckCircle2],['transfer','نقص',ArrowDownToLine],['return','زيادة',RotateCcw],['review','تحتاج تحقق',Search],
      ] as const).map(([key,label,Icon])=><button type="button" className={'stat '+(filter===key?'selected':'')} key={key} onClick={()=>setFilter(filter===key?'action':key)} aria-pressed={filter===key}><Icon size={20}/><span>{label}</span><strong>{closingUnavailable&&key!=='review'?'—':counts[key]}</strong></button>)}</div>
      <section className="panel reassurance-council">
        <div className="section-title"><ShieldCheck size={22}/><h2>مصادر طمني — الجندي والملازم أول والعقيد</h2></div>
        <p className="hint">فحص قراءة فقط من سجلات المشروع وقرارات الملازم والعقيد المحفوظة، ومع كل تحديث جديد في الأرشيف. لا يعدّل فواتيرك، ولا يكتب في SAP، ولا يحوّل قرارًا إداريًا إلى دليل على رصيد المستودع.</p>
        {!crossChecked&&<div className="banner error" role="alert"><b>الفحص الشامل غير مكتمل</b>
          {(loaded?.councilWarnings||[]).map((warning,i)=><p key={i}>{warning}</p>)}
          {!loaded?.councilWarnings.length&&<p>تعذّر تحميل أحد مصادر الجندي أو الملازم أو العقيد.</p>}
        </div>}
        <div className="stats reassurance-stats">{sourceMeta.map(source=><button type="button" key={source.id} className="stat"
          onClick={()=>onNavigate(source.view)} title={'افتح '+source.name}>
          <span>{source.name}</span><small>{source.detail}</small><b>فتح المصدر</b>
        </button>)}</div>
        {crossChecked&&<>
          <p className="hint">قرارات الملازم المحفوظة: <b>{council?.lieutenant.savedDecisions||0}</b> · مستندات SAP تحتاج تحقق: <b>{council?.lieutenant.review||0}</b> · فواتير بتاريخ مستنتج من SAP: <b>{council?.soldier.inferredDates||0}</b>.</p>
          <div className="banner info">
            <b>وصول فواتير سجى غير مثبت تلقائيًا:</b> الجندي يراجع ملف Excel عند رفعه داخل شاشته، لكن آخر ملف سجى ونتائج فحصه غير محفوظين كمصدر يمكن لـ«طمني» قراءته. لذلك لا يوجد حكم نهائي على وصول الورق من مقارنة SAP وحدها.
          </div>
          {councilFindings.length>0?<details className="reassurance-details" open>
            <summary>معلومات ناقصة أو تحتاج حسمًا ({councilFindings.length}) — افتح مصدر كل ملاحظة</summary>
            {(['soldier','lieutenant','colonel'] as const).map(group=>{
              const list=councilFindings.filter(finding=>finding.source===group);
              return list.length?<div key={group} className="reassurance-council-group">
                <h3>{group==='soldier'?'الجندي السيريل':group==='lieutenant'?'الملازم أول':'العقيد'} · {list.length} ملاحظة</h3>
                {list.slice(0,4).map((finding,i)=><p key={i}><b>{finding.title}: </b>{finding.details}
                  <button type="button" className="button secondary small" onClick={()=>openCouncilFinding(finding)}>فتح المصدر</button></p>)}
                {list.length>4&&<button type="button" className="button secondary" onClick={()=>onNavigate(group==='soldier'?'serial-soldier':group==='lieutenant'?'lieutenant':'colonel')}>
                  عرض بقية حالات هذا المصدر ({list.length-4})
                </button>}
              </div>:null;
            })}
          </details>:<p className="hint">لم تظهر تنبيهات إضافية من سجلات الجندي والملازم والعقيد للفترة المختارة. فحص ملف سجى الخارجي يبقى مستقلًا.</p>}
        </>}
      </section>
      <section className="panel">
        <p className="hint">مصدر الترحيلات من أرشيف الملازم أول في Supabase: {loaded?.sourceName||'غير متاح'} · آخر حركة ظاهرة: <b dir="ltr">{report.sourceLastDate||'—'}</b> · رصيد 011 بتاريخ <b dir="ltr">{loaded?.closing?.date||'غير متاح'}</b>. يتم تحديث المصدر عند فتح الشاشة، وعند الرجوع إليها بعد تحديث الملفات، وبزر «طمني الآن».</p>
        <p className="hint"><b>{report.settlements.length}</b> ترحيل أصلي مسوّى بعكسي كامل أو تصحيح سالب مطابق حسب فحص الملازم أول؛ لا يظهر ضمن اقتراحات الإلغاء. هذا لا يُلغي الحاجة إلى مطابقة الرصيد الفعلي للصنف.</p>
        {loaded?.closing&&loaded.closing.date!==to&&<button type="button" className="button secondary no-print" onClick={()=>{setFrom(loaded.closing!.date.slice(0,8)+'01');setTo(loaded.closing!.date)}}>افحص بتاريخ آخر رصيد محفوظ ({loaded.closing.date})</button>}
        {!!report.issues.length&&<div className="banner error" role="alert"><b>الفحص غير مكتمل</b><ul>{report.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul><p>المصدر المعتمد للرصيد هو كشف SAP الفعلي بتاريخ الفحص. يُقرأ من الملف الشامل عندما تتوفر أقسام الأرصدة وتواريخها الصحيحة، وإلا يلزم رفع كشف رصيد مؤرّخ. الترحيلات وحدها لا تثبت رصيد 011.</p><a href="/reconciliation?view=sap-files">فتح ملفات SAP للتحقق من كشف الرصيد</a></div>}
        <p className="hint">دليل الكميات: {report.paperGroups} مجموعة من بنود الفواتير الورقية · {report.approvedGroups} مجموعة من ترحيلات SAP المعتمدة سابقًا. الاعتماد المالي مستقل عن دليل الكميات.</p>
        {report.financialPending>0&&<div className="banner info" role="status">هناك {report.financialPending} سجل لم يعتمد ماليًا بعد. نتيجة الكميات لا تُعد اعتمادًا ماليًا، وراجع حالة كل فاتورة قبل إغلاقها.</div>}
        {report.approvedGroups>0&&<p className="hint">استُخدمت كميات {report.approvedGroups} مجموعة من نسخة الترحيلات المحفوظة وقت اعتمادها، مرة واحدة لكل مجموعة. يظهر مصدر الكمية في تفاصيل الصنف.</p>}
        {!!report.pendingRecords.length&&<details className="reassurance-details"><summary>{report.pendingRecords.length} سجل يحتاج استكمالًا أو مراجعة</summary>{report.pendingRecords.map(record=><div key={record.id}><button type="button" className="button secondary" onClick={()=>onOpenRecord(record.id)}>فتح {record.numbers.join('، ')}</button><p>{record.branch} · {record.note}</p></div>)}</details>}
        <div className="table-controls no-print"><div className="search"><Search size={17}/><input type="search" aria-label="بحث في نتيجة طمني" placeholder="كود الصنف، اسمه أو رقم ترحيل (بما فيها المسوّاة)" value={search} onChange={event=>setSearch(event.target.value)}/></div>
          <label>العرض<select value={filter} onChange={event=>setFilter(event.target.value)}><option value="candidate">ترحيلات محددة مرشحة للفحص</option><option value="action">كل الفروقات غير المحسومة</option><option value="all">كل الأصناف</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div>
        {matchedSettlements.map(item=><div className="banner info" key={item.number} role="status">
          <b>الترحيل {item.number} مسوّى لدى الملازم أول، وليس مرشحًا للإلغاء مجددًا.</b>
          <p>{item.note}</p>
          <p>المستند المقابل: <b dir="ltr">{item.counterparts.join('، ')||'غير متاح'}</b> · تاريخ الأصل <b dir="ltr">{item.date}</b> · {item.branch||'الفرع غير مثبت'}.</p>
          <button type="button" className="button secondary" onClick={()=>openCandidate(item.number)}>فتح الترحيل الأصلي</button>
          {item.counterparts.map(number=><button type="button" className="button secondary" key={number} onClick={()=>openCandidate(number)}>فتح العكسي {number}</button>)}
          <small>صافي الحركة المسوّاة صفر؛ هذا لا يثبت أن باقي حركات الصنف ورصيد 011 متطابقة.</small>
        </div>)}
        {visible.length?<div className="table-scroll"><table className="reassurance-table"><thead><tr><th>الصنف</th><th>كميات الفواتير</th><th>الافتتاحي</th><th>المتوقع في 011</th><th>رصيد 011 الفعلي</th><th>الفرق</th><th>المطلوب</th></tr></thead>
          <tbody>{visible.map(row=><tr key={row.code}><td><b dir="ltr">{row.code}</b><div>{row.name}</div><small>حبة</small></td>
            <td dir="ltr">{quantity(row.invoices)}</td><td dir="ltr">{quantity(row.opening)}</td><td dir="ltr">{quantity(row.expected)}</td><td dir="ltr">{quantity(row.actual)}</td>
            <td dir="ltr" className={row.state==='match'?'green':row.difference?'red':''}><b>{row.difference!==null&&row.difference>0?'+':''}{quantity(row.difference)}</b></td>
            <td><span className={'badge '+badge(row.state)}>{labels[row.state]}</span>
            {row.candidates.length>0?<div className="reassurance-action">
              <p><b>{row.candidates.length===1?'ترحيل واحد مرشح للفحص:':'أكثر من ترحيل مطابق؛ لا تختار إلغاءً قبل الحسم:'}</b></p>
              {row.candidates.map(doc=><div key={doc.number}>
                <button type="button" className="button secondary" onClick={()=>openCandidate(doc.number)}>
                  فتح الترحيل {doc.number}</button>
                <span dir="ltr"> {doc.date} · {quantity(doc.quantity)} حبة</span>
                <p>{doc.direction} · {doc.itemCount} صنف في المستند · {doc.branch||'الفرع غير مثبت'}</p>
                {(doc.stockUnexplained||doc.cancellationState!=='active'||doc.invoiceNumbers.length>0)&&
                  <p className="amber">{[
                    doc.stockUnexplained?'الرصيد أو مصدر الحركة يحتاج تدقيقًا.':'',
                    doc.cancellationState!=='active'?'حالة إلغاء SAP غير مثبتة.':'',
                    doc.invoiceNumbers.length?'ملاحظات SAP تشير إلى فاتورة '+doc.invoiceNumbers.join('، ')+'.':'',
                  ].filter(Boolean).join(' ')}</p>}
              </div>)}
              <p className="hint">هذه ترحيلات مرشحة فقط؛ لا إلغاء تلقائي. يجب التأكد أن المستند زائد وغير مغطّى بفواتير وأن الإلغاء لا يسبب فرقًا آخر.</p>
            </div>:row.difference!==null&&Math.abs(row.difference)>0.000001?
              <p className="hint">لم يُحدّد ترحيل مستقل يفسّر هذا الفرق كاملًا. لا يمكن اقتراح إلغاء من قائمة حركات الصنف وحدها.</p>:null}
            <details className="reassurance-details"><summary>بيانات التدقيق الإضافية (اختياري)</summary>
              <p>صافي الترحيلات: {quantity(row.netTransfers)} حبة · فرق الرصيد عن الافتتاحي والترحيلات: {quantity(row.stockDifference)} حبة.</p>
              {row.notes.map((note,i)=><p key={i} className="amber">{note}</p>)}
              <details className="reassurance-details"><summary>الفواتير المرتبطة ({row.records.length})</summary>
              {row.records.map(record=><p key={record.id}><button type="button" className="button secondary" onClick={()=>onOpenRecord(record.id)}>الفواتير {record.numbers.join('، ')}</button><small>{record.basis==='paper'?'كميات الفاتورة المسجلة':'كميات المجموعة المحفوظة وقت الاعتماد'}</small></p>)}</details>
              <details className="reassurance-details"><summary>كل حركات الصنف للبحث اليدوي ({row.evidence.length}) — ليست ترشيحات للإلغاء</summary>
              {row.evidence.length?<div className="reassurance-documents">{row.evidence.map((doc,i)=><div key={doc.number+'-'+i}><button type="button" className="button secondary" onClick={()=>{
                const source=loaded?.transfers.find(item=>item.transfer.number===doc.number);
                if(source)onOpenTransfer(source.transfer,source.branch);
              }}>الترحيل {doc.number}</button><span dir="ltr">{doc.date} · {doc.direction} · {quantity(doc.quantity)} {doc.unit}</span><small>{doc.remarks}</small></div>)}</div>:<p>لا توجد حركة لهذا الصنف في فترة كشف الترحيلات.</p>}
              </details>
            </details></td></tr>)}</tbody></table></div>:<p className="reassurance-empty">{query&&matchedSettlements.length?'الترحيل المطلوب مسوّى حسب الملازم أول ولا يظهر ضمن المرشحين للإلغاء.':query?'لا توجد ترحيلات مرشحة تطابق البحث.':filter==='candidate'?'لم يثبت ترحيل واحد يفسّر الفروقات كلها بشروط الفحص. افتح «كل الفروقات غير المحسومة» للتدقيق، ولا تُلغِ مستندًا بالتخمين.':filter==='action'&&settled?'كل الأصناف مطابقة ضمن الفترة.':'لا توجد أصناف ضمن هذا العرض.'}</p>}
      </section>
    </>}
  </div>;
}
