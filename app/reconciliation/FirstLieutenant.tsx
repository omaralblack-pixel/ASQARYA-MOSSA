'use client';

import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import {AlertTriangle,CheckCircle2,Copy,FileArchive,FileUp,RefreshCw,Search,ShieldCheck,Trash2} from 'lucide-react';
import {decodeLieutenantFile} from '../lib/lieutenant-file';
import {parseLieutenantTransfers,type LieutenantTransfer} from '../lib/lieutenant';
import {analyzeLieutenantMovements} from '../lib/lieutenant-counterparts';
import {invoiceDocumentNo,transferNumbers,type Draft,type Transfer} from '../lib/reconcile';
import {sapStockBalanceQuery} from '../lib/sap-stock-query';
import {auditLieutenantStock,classifyLieutenantContent,parseLieutenantStock,
  type StockItem,type LieutenantFileKind} from '../lib/lieutenant-stock';

type FileKind=LieutenantFileKind;
type StoredFile={key:string;name:string;kind:FileKind;size:number;created:string;snapshotDate?:string};
type StockSnapshot={key:string;date:string;items:StockItem[];issues:string[]};
type SavedRecord={id:string;branch:string;status:string;payload:string};
type QueueRecord={transfer_no:string;doc_date:string;payload:string;source_file:string;created:string};
type OpeningStock={snapshot_date:string;warehouse:string;sap_code:string;item_name:string;unit:string;quantity:number;source:string;approved_at:string};
type RecordSnapshot={records:SavedRecord[];queue:QueueRecord[];openingStock:OpeningStock[]};
type ReviewStatus='approved'|'paper'|'linked'|'unlinked'|'queued'|'missing'|'review'|'reversed'|'reverse'|'sap-canceled'|'sap-cancel-doc'|'cashvan-pending'|'cancellation-review';
type ReviewRow={source:LieutenantTransfer;status:ReviewStatus;recordId?:string;note:string};

const fileKinds:Record<FileKind,string>={
  transfers:'جميع ترحيلات SAP من وإلى 011',
  opening:'رصيد 011 الافتتاحي',
  balance:'رصيد 011 الفعلي في نهاية الفترة',
  other:'مستند مساعد للتدقيق',
};
const statusText:Record<ReviewStatus,string>={
  approved:'مطابق ومعتمد',
  paper:'الفاتورة مرتبطة، والورق غير مؤكد',
  linked:'مرتبط بفاتورة، المطابقة غير مكتملة',
  unlinked:'ترحيل محفوظ بلا رقم فاتورة زرقاء',
  queued:'مستورد تلقائيًا — بانتظار الجندي',
  missing:'غير مستورد — يحتاج معالجة',
  review:'يحتاج مراجعة بيانات SAP',
  reversed:'تمت التسوية بعكسي مطابق',
  reverse:'ترحيل عكسي — بلا فاتورة مستقلة',
  'sap-canceled':'ملغى رسميًا على SAP',
  'sap-cancel-doc':'مستند إلغاء SAP',
  'cashvan-pending':'كاش فان — عكسي/إلغاء غير مثبت',
  'cancellation-review':'إلغاء يحتاج تحقق',
};
const empty:RecordSnapshot={records:[],queue:[],openingStock:[]};
const fileLimit=16*1024*1024;
// Local calendar day, not UTC, because SAP stock is dated by posting day.
function todayLocal():string{
  const value=new Date();
  return value.getFullYear()+'-'+String(value.getMonth()+1).padStart(2,'0')+'-'+
    String(value.getDate()).padStart(2,'0');
}
async function fetchArchivedTransfer(file:StoredFile,branches:string[]){
  const response=await fetch('/api/lieutenant-files?key='+encodeURIComponent(file.key),
    {cache:'no-store',redirect:'manual'});
  if(response.status===401||response.type==='opaqueredirect')
    throw Error('انتهت جلسة الدخول. سجّل دخولك من جديد.');
  if(!response.ok)throw Error('تعذّر قراءة ترحيلات الأرشيف: HTTP '+response.status);
  const source=decodeLieutenantFile(await response.arrayBuffer(),file.name);
  if(classifyLieutenantContent(source)!=='transfers')
    throw Error('الملف '+file.name+' ليس كشف ترحيلات فعلًا.');
  const result=parseLieutenantTransfers(source,branches);
  if(!result.transfers.length)
    throw Error('الملف '+file.name+' لا يحتوي ترحيلات 011 قابلة للقراءة.');
  return result;
}
async function checkedJson<T>(url:string,init?:RequestInit):Promise<T>{
  let response:Response;
  try{response=await fetch(url,{cache:'no-store',redirect:'manual',...init})}
  catch{throw Error('انقطع الاتصال بالسيرفر أثناء طلب '+url.split('?')[0]+'. البيانات المرفوعة سابقًا لا تحتاج إعادة رفع.')}
  if(response.status===401||response.status===403&&response.headers.get('location')?.includes('/login')||
    response.type==='opaqueredirect'||[301,302,303,307,308].includes(response.status)){
    window.location.assign('/login');
    throw Error('انتهت جلسة الدخول. سجّل دخولك وافتح الملف المحفوظ من الأرشيف.');
  }
  if(response.status===413)throw Error('حجم دفعة الترحيلات أكبر من الحد المسموح. الملف الأصلي محفوظ؛ افتحه وأعد فحص الناقص.');
  const body=await response.text();
  const contentType=response.headers.get('content-type')||'';
  if(!contentType.includes('json')&&!body.trimStart().startsWith('{')&&!body.trimStart().startsWith('[')){
    throw Error('السيرفر أعاد صفحة HTML بدل بيانات JSON عند '+url.split('?')[0]+
      ' (HTTP '+response.status+'). الملف المحفوظ لم يُحذف؛ المشكلة في مسار الخادم أو جلسة الدخول، وليس في محتوى SAP.');
  }
  let data:T&{error?:string};
  try{data=JSON.parse(body) as T&{error?:string}}
  catch{throw Error('السيرفر أعاد بيانات غير صالحة عند '+url.split('?')[0]+' (HTTP '+response.status+').')}
  if(!response.ok)throw Error(data?.error||'تعذّر إتمام الطلب '+url.split('?')[0]+' (HTTP '+response.status+').');
  return data;
}

const completeStatuses=new Set<ReviewStatus>(['approved','reversed','reverse','sap-canceled','sap-cancel-doc']);
const soldierEligible=(status:ReviewStatus)=>['missing','queued','unlinked','linked','paper'].includes(status);
function makeRows(transfers:LieutenantTransfer[],snapshot:RecordSnapshot,periodEnd:string):ReviewRow[]{
  const movements=analyzeLieutenantMovements(transfers,periodEnd);
  const saved=new Map<string,{id:string;status:ReviewStatus;note:string}>();
  for(const record of snapshot.records){
    let draft:Draft;
    try{draft=JSON.parse(record.payload) as Draft}catch{continue}
    const numbers=(draft.invoices||[]).map(inv=>invoiceDocumentNo(inv.number)).filter(Boolean);
    const hasPaper=numbers.length>0&&(draft.invoices||[]).filter(inv=>invoiceDocumentNo(inv.number)).every(inv=>inv.complete);
    const matched=record.status==='match'&&hasPaper;
    const status:ReviewStatus=matched?'approved':numbers.length?
      hasPaper?'linked':'paper':'unlinked';
    const note=numbers.length?'الفواتير: '+numbers.join('، '):'لم يُحدد رقم فاتورة زرقاء.';
    for(const transfer of draft.transfers||[])
      for(const number of transferNumbers(transfer.number||''))
        saved.set(number,{id:record.id,status,note});
  }
  const queue=new Set(snapshot.queue.map(row=>row.transfer_no));
  return transfers.map(source=>{
    const number=source.transfer.number;
    const result=saved.get(number);
    if(source.issues.length)return {source,status:'review',note:source.issues.join(' · ')};
    const movement=movements.get(number);
    if(movement&&movement.kind!=='normal')
      return {source,status:movement.kind,recordId:result?.id,note:movement.note};
    if(result)return {source,status:result.status,recordId:result.id,note:result.note};
    if(queue.has(number))return {source,status:'queued',note:'محفوظ مستقلًا عن الفواتير؛ لم تُنشأ فاتورة تلقائية.'};
    return {source,status:'missing',note:'الترحيل موجود في ملف SAP، لكن ليس في السجل ولا قائمة الجندي.'};
  });
}

function MovementSummary({rows}:{rows:ReviewRow[]}){
  const movements=useMemo(()=>{
    const totals=new Map<string,{code:string;unit:string;inward:number;outward:number}>();
    for(const {source} of rows){
      if(source.issues.length||['canceled','cancellation'].includes(source.cancellationState))continue;
      for(const line of source.transfer.paste.split('\n').slice(1)){
        const [code,,quantity,unit,from,to]=line.split('\t');
        const qty=Number(quantity.replace(/,/g,''));
        if(!code||!Number.isFinite(qty))continue;
        const key=code+'|'+unit;
        const item=totals.get(key)||{code,unit,inward:0,outward:0};
        if(to==='011'&&from!=='011')item.inward+=qty;
        else if(from==='011'&&to!=='011')item.outward+=qty;
        totals.set(key,item);
      }
    }
    return [...totals.values()].sort((a,b)=>a.code.localeCompare(b.code));
  },[rows]);
  if(!movements.length)return null;
  return <details className="panel">
    <summary>صافي الحركة حسب كود SAP ووحدة الترحيل ({movements.length})</summary>
    <p className="hint">صافي أولي من الملف، وليس رصيد SAP موثّقًا. لم تدخل مستندات الإلغاء Y وC في هذا الجدول. لا نجمع KG مع Carton أو Piece، وتبقى التسويات وحالة الإلغاء وتواريخها بحاجة للتحقق من سجل حركة المخزون.</p>
    <div className="table-scroll"><table><thead><tr><th>كود SAP</th><th>الوحدة</th><th>الوارد</th><th>الصادر</th><th>صافي الحركة</th></tr></thead><tbody>
      {movements.map(row=><tr key={row.code+'|'+row.unit}><td dir="ltr">{row.code}</td><td>{row.unit}</td><td>{row.inward}</td><td>{row.outward}</td><td>{Number((row.inward-row.outward).toFixed(6))}</td></tr>)}
    </tbody></table></div>
  </details>;
}

export default function FirstLieutenant({branches,onOpenTransfer,onOpenRecord}:{
  branches:string[];
  onOpenTransfer:(transfer:Transfer,branch:string)=>void;
  onOpenRecord:(id:string)=>void;
}){
  const [kind,setKind]=useState<FileKind>('transfers');
  const [files,setFiles]=useState<StoredFile[]>([]);
  const [nextPage,setNextPage]=useState<number|null>(null);
  const [selected,setSelected]=useState('');
  const [selectedTransfer,setSelectedTransfer]=useState('');
  const [closing,setClosing]=useState<StockSnapshot|null>(null);
  const [opening,setOpening]=useState<StockSnapshot|null>(null);
  const [transfers,setTransfers]=useState<LieutenantTransfer[]>([]);
  const [issues,setIssues]=useState<string[]>([]);
  const [snapshot,setSnapshot]=useState<RecordSnapshot>(empty);
  const [snapshotLoaded,setSnapshotLoaded]=useState(false);
  const [from,setFrom]=useState(()=>todayLocal().slice(0,8)+'01');
  const [to,setTo]=useState(todayLocal);
  const [stockDate,setStockDate]=useState<string|null>(null);
  const [stockCopyMessage,setStockCopyMessage]=useState('');
  const stockQueryRef=useRef<HTMLTextAreaElement>(null);
  const stockQueryDate=stockDate??to;
  const stockQuery=sapStockBalanceQuery(stockQueryDate);
  const [filter,setFilter]=useState('pending');
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [autoLoading,setAutoLoading]=useState(false);
  const [transferSourceName,setTransferSourceName]=useState('');
  const transferSelectedRef=useRef(false);

  async function copyStockQuery(){
    if(!stockQuery)return;
    let copied=false;
    try{
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(stockQuery);
        copied=true;
      }
    }catch{/* Older browsers can use the selected textarea below. */}
    if(!copied){
      stockQueryRef.current?.focus();
      stockQueryRef.current?.select();
      try{copied=document.execCommand('copy')}catch{/* Keep the text selected for manual copy. */}
    }
    setStockCopyMessage(copied?'تم نسخ الكويري كاملًا لتاريخ '+stockQueryDate+'.':
      'المتصفح منع النسخ التلقائي. تم تحديد الكويري؛ اضغط Ctrl+C أو اختر نسخ.');
  }

  async function refreshSnapshot(){
    const state=await checkedJson<RecordSnapshot>('/api/reconcile?lieutenant=1');
    setSnapshot(state);
    setSnapshotLoaded(true);
    return state;
  }
  async function refreshFiles(page=0){
    const next=await checkedJson<{files:StoredFile[];nextPage:number|null}>('/api/lieutenant-files?page='+page);
    setFiles(current=>page?[...current,...next.files]:next.files);
    setNextPage(next.nextPage);
    return next.files;
  }
  async function deleteArchive(file:StoredFile){
    if(!window.confirm('حذف الملف "'+file.name+'" نهائيًا من أرشيف الملازم أول؟ لن تُحذف الفواتير أو الترحيلات أو المطابقات المحفوظة، لكن نسخة الملف الأصلية لن تعود متاحة من الأرشيف.'))return;
    setBusy(true);setError('');setMessage('');
    try{
      const result=await checkedJson<{deleted:boolean;key:string}>('/api/lieutenant-files',{
        method:'DELETE',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:file.key}),
      });
      if(!result.deleted||result.key!==file.key)throw Error('الخادم لم يؤكد حذف الملف المحدد.');
      if(selected===file.key)setSelected('');
      if(selectedTransfer===file.key){
        transferSelectedRef.current=false;setSelectedTransfer('');
        setTransferSourceName('');setTransfers([]);setIssues([]);
      }
      if(closing?.key===file.key)setClosing(null);
      if(opening?.key===file.key)setOpening(null);
      await refreshFiles();
      setMessage('تم حذف "'+file.name+'" من أرشيف الملفات فقط. الترحيلات والفواتير المحفوظة لم تتغير.');
    }catch(cause){
      setError(cause instanceof Error?cause.message:'تعذّر حذف الملف من الأرشيف.');
    }finally{setBusy(false)}
  }
  async function readArchive(file:StoredFile){
    setError('');setMessage('');setBusy(true);
    try{
      const response=await fetch('/api/lieutenant-files?key='+encodeURIComponent(file.key),
        {cache:'no-store',redirect:'manual'});
      if(response.status===401){window.location.assign('/login');throw Error('انتهت الجلسة؛ سجّل دخولك من جديد.');}
      if(!response.ok)throw Error('تعذّر فتح ملف SAP المحفوظ (HTTP '+response.status+').');
      const bytes=await response.arrayBuffer();
      const text=decodeLieutenantFile(bytes,file.name);
      const actualKind=classifyLieutenantContent(text);
      let key=file.key;
      let date=actualKind===file.kind?(file.snapshotDate||''):'';
      let correctionWarning='';
      if(actualKind!==file.kind){
        // Copy misclassified legacy originals to the correct archive without
        // deleting the original or manufacturing a stock snapshot date.
        try{
          const fixed=await checkedJson<{key:string}>('/api/lieutenant-files',{
            method:'POST',headers:{
              'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name),
              'X-File-Kind':actualKind,
            },body:bytes,
          });
          key=fixed.key;
          await refreshFiles();
        }catch{
          correctionWarning=' تعذّر حفظ نسخة بالتصنيف الجديد؛ الملف القديم باقٍ ويمكن إعادة رفعه.';
        }
      }
      setSelected(key);setKind(actualKind);
      const repaired=(key!==file.key?' تم حفظ نسخة مصنّفة بشكل صحيح، وبقي الملف الأصلي كما هو.':'')+
        correctionWarning;
      if(actualKind==='balance'||actualKind==='opening'){
        const parsed=parseLieutenantStock(text,actualKind);
        const stock={key,date,items:parsed.items,issues:parsed.issues};
        if(actualKind==='balance'){
          setClosing(stock);
          if(date){setTo(date);setStockDate(null);setStockCopyMessage('');}
        }else setOpening(stock);
        setMessage('تم فتح '+fileKinds[actualKind]+': '+parsed.items.length+
          ' صنفًا للمستودع 011.'+(date?' تاريخ اللقطة: '+date+'.':
          ' تاريخ هذه النسخة القديمة غير محدد؛ أعد رفعها مع اختيار تاريخ صحيح لتفعيل المقارنة.')+
          repaired);
        return;
      }
      if(actualKind!=='transfers'){
        setMessage('الملف محفوظ، لكن أعمدته لا تطابق كشف الترحيلات أو الرصيد المعروف. لم يُرسل شيء للجندي.'+repaired);
        return;
      }
      const parsed=parseLieutenantTransfers(text,branches);
      transferSelectedRef.current=true;
      setTransferSourceName(file.name);
      setSelectedTransfer(key);
      setTransfers(parsed.transfers);setIssues(parsed.issues);
      setMessage('تم فتح ملف الترحيلات: '+parsed.transfers.length+' ترحيلًا للمستودع 011.'+repaired);
    }catch(cause){
      setError(cause instanceof Error?cause.message:'تعذّر فحص الملف المحفوظ.');
    }finally{setBusy(false)}
  }
  useEffect(()=>{
    let active=true;
    async function init(){
      const [archive,state]=await Promise.allSettled([
        checkedJson<{files:StoredFile[];nextPage:number|null}>('/api/lieutenant-files?page=0'),
        checkedJson<RecordSnapshot>('/api/reconcile?lieutenant=1'),
      ]);
      if(!active)return;
      const errors:string[]=[];
      if(archive.status==='fulfilled'){
        setFiles(archive.value.files);setNextPage(archive.value.nextPage);
        // Restore read-only source data. Do not enqueue or create an invoice.
        const candidates=archive.value.files.filter(file=>file.kind==='transfers');
        if(candidates.length){
          setAutoLoading(true);
          let loaded=false;
          try{
            for(const candidate of candidates){
              if(!active||transferSelectedRef.current)break;
              try{
                const result=await fetchArchivedTransfer(candidate,branches);
                if(!active||transferSelectedRef.current)break;
                transferSelectedRef.current=true;
                setSelectedTransfer(candidate.key);
                setTransferSourceName(candidate.name);
                setTransfers(result.transfers);setIssues(result.issues);
                loaded=true;
                break;
              }catch{/* Older files may be misclassified; skip only this candidate. */}
            }
            if(active&&!loaded&&!transferSelectedRef.current)
              errors.push('لا يوجد ملف ترحيلات قابل للقراءة بين الملفات المسجّلة كترحيلات. افتح ملف SAP الصحيح من الأرشيف.');
          }finally{if(active)setAutoLoading(false);}
        }
      }else{
        errors.push(archive.reason instanceof Error?archive.reason.message:'تعذّر تحميل أرشيف الملازم أول.');
      }
      if(state.status==='fulfilled'){
        setSnapshot(state.value);setSnapshotLoaded(true);
      }else{
        errors.push(state.reason instanceof Error?state.reason.message:'تعذّر تحميل بيانات المطابقة.');
      }
      if(errors.length)setError(errors.join(' '));
    }
    void init();
    return()=>{active=false};
  },[]);

  const rows=useMemo(()=>makeRows(transfers,snapshot,to).filter(row=>
    row.source.transfer.date>=from&&row.source.transfer.date<=to),[transfers,snapshot,from,to]);
  const pending=rows.filter(row=>!completeStatuses.has(row.status));
  const visible=rows.filter(row=>(filter==='all'||(filter==='pending'?!completeStatuses.has(row.status):row.status===filter))&&
    (!query||[row.source.transfer.number,row.source.branch,row.source.remarks,row.note].some(value=>value.includes(query))));
  const counts=useMemo(()=>({
    approved:rows.filter(row=>row.status==='approved').length,
    queued:rows.filter(row=>row.status==='queued').length,
    review:rows.filter(row=>row.status==='review'||row.status==='cashvan-pending'||row.status==='cancellation-review').length,
    pending:pending.length,
  }),[rows,pending.length]);
  const approvedTransferNumbers=useMemo(()=>{
    const approved=new Set<string>();
    for(const record of snapshot.records){
      if(record.status!=='match')continue;
      let draft:Draft;
      try{draft=JSON.parse(record.payload) as Draft}catch{continue}
      const invoices=draft.invoices||[];
      if(!invoices.length||!invoices.every(row=>!!invoiceDocumentNo(row.number)&&row.complete))continue;
      for(const transfer of draft.transfers||[])
        for(const num of transferNumbers(transfer.number||''))approved.add(num);
    }
    return approved;
  },[snapshot.records]);
  const canCompare=!!closing?.date&&closing.date===to&&!!selectedTransfer&&from<=to;
  const stockRows=useMemo(()=>{
    if(!closing?.items.length)return [];
    const byKey=new Map<string,StockItem>();
    for(const item of snapshot.openingStock){
      if(item.snapshot_date!==from||item.warehouse!=='011')continue;
      byKey.set(item.sap_code+'|'+item.unit,{
        code:item.sap_code,name:item.item_name,warehouse:'011',unit:item.unit,quantity:Number(item.quantity)});
    }
    if(opening?.date===from)
      for(const item of opening.items)if(!byKey.has(item.code+'|'+item.unit))
        byKey.set(item.code+'|'+item.unit,item);
    return auditLieutenantStock(closing.items,[...byKey.values()],
      canCompare?transfers:[],canCompare?approvedTransferNumbers:new Set<string>(),from,to);
  },[closing,opening,snapshot.openingStock,from,to,transfers,approvedTransferNumbers,canCompare]);

  async function enqueue(source:LieutenantTransfer[],key:string){
    // Cash Van, the exact reverse, SAP-canceled and cancellation documents
    // are inventory-control cases, not missing blue invoices.
    const movements=analyzeLieutenantMovements(source,'9999-12-31');
    const valid=source.filter(row=>!row.issues.length&&movements.get(row.transfer.number)?.kind==='normal');
    const skipped=source.length-valid.length;
    let added=0,existing=0;
    const batches:Array<Array<{number:string;date:string;paste:string;branch:string;remarks:string;reverse:boolean;cancellationMentioned:boolean;cancellationState:string;invoiceNumbers:string[]}>>=[];
    let batch:typeof batches[number]=[];
    for(const row of valid){
      const data={number:row.transfer.number,date:row.transfer.date,paste:row.transfer.paste,
        branch:row.branch,remarks:row.remarks,reverse:row.reverse,
        cancellationMentioned:row.cancellationMentioned,cancellationState:row.cancellationState,invoiceNumbers:row.invoiceNumbers};
      const next=[...batch,data];
      const size=new Blob([JSON.stringify({action:'lieutenantImport',sourceFile:key,transfers:next})]).size;
      if(batch.length&&(next.length>10||size>650000)){
        batches.push(batch);batch=[data];
      }else batch=next;
      if(new Blob([JSON.stringify({action:'lieutenantImport',sourceFile:key,transfers:batch})]).size>1800000)
        throw Error('الترحيل '+data.number+' كبير جدًا لإرساله بدفعة واحدة؛ ملف SAP محفوظ بالأرشيف ويمكن مراجعة هذا الترحيل بشكل منفصل.');
    }
    if(batch.length)batches.push(batch);
    for(const payload of batches){
      const result=await checkedJson<{added:number;existing:number}>('/api/reconcile',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'lieutenantImport',sourceFile:key,transfers:payload}),
      });
      added+=result.added;existing+=result.existing;
    }
    await refreshSnapshot();
    return {added,existing,skipped};
  }

  async function upload(event:ChangeEvent<HTMLInputElement>){
    const input=event.currentTarget;
    const file=input.files?.[0];
    input.value='';
    if(!file)return;
    setError('');setMessage('');setBusy(true);
    try{
      if(file.size>fileLimit)throw Error('حجم الملف يتجاوز 16 ميغابايت.');
      const bytes=await file.arrayBuffer();
      let text='',detected:FileKind='other',decodeIssue='';
      try{
        text=decodeLieutenantFile(bytes,file.name);
        detected=classifyLieutenantContent(text);
      }catch(cause){decodeIssue=cause instanceof Error?cause.message:'تعذّر قراءة نوع الملف.';}
      const date=detected==='balance'?stockQueryDate:detected==='opening'?from:'';
      if(date&&!sapStockBalanceQuery(date))throw Error('اختر تاريخًا صحيحًا قبل إرفاق كشف الرصيد.');
      if(date>todayLocal())throw Error('لا يمكن اعتماد رصيد SAP بتاريخ مستقبلي؛ اختر تاريخ اللقطة الحقيقي.');
      // Save the original bytes first, categorized by actual columns, not by
      // the selected hint or by its filename.
      const stored=await checkedJson<{key:string;name:string;duplicate:boolean}>('/api/lieutenant-files',{
        method:'POST',
        headers:{
          'Content-Type':file.type||'application/octet-stream',
          'X-File-Name':encodeURIComponent(file.name),
          'X-File-Kind':detected,
          'X-Snapshot-Date':date,
        },
        body:bytes,
      });
      setKind(detected);setSelected(stored.key);
      let warning='';
      try{await refreshFiles()}catch{warning=' (تعذّر تحديث قائمة الأرشيف، لكن الخادم أكد حفظ الملف).';}
      const saved='تم حفظ الملف الأصلي في Supabase'+(stored.duplicate?' (كان محفوظًا مسبقًا)':'')+'. ';
      const reclassified=kind!==detected?' التصنيف الصحيح حسب الأعمدة: '+fileKinds[detected]+'.':'';
      if(detected==='opening'||detected==='balance'){
        const parsed=parseLieutenantStock(text,detected);
        const stock={key:stored.key,date,items:parsed.items,issues:parsed.issues};
        if(detected==='balance'){
          setClosing(stock);setTo(date);setStockDate(null);setStockCopyMessage('');
        }else setOpening(stock);
        setMessage(saved+'تمت قراءة '+parsed.items.length+' صنفًا من '+fileKinds[detected]+
          ' بتاريخ '+date+'. لم تُنشأ فاتورة أو يُرسل شيء للجندي.'+reclassified+warning);
        return;
      }
      if(detected==='other'){
        setMessage(saved+(decodeIssue||'أعمدة الملف غير معروفة؛ راجع الملف قبل استخدامه في التدقيق.')+
          ' لم يُرسل شيء للجندي.'+reclassified+warning);
        return;
      }
      const result=parseLieutenantTransfers(text,branches);
      transferSelectedRef.current=true;
      setSelectedTransfer(stored.key);
      setTransferSourceName(file.name);
      setTransfers(result.transfers);setIssues(result.issues);
      if(!result.transfers.length){
        setMessage(saved+'لم يُعثر على ترحيلات صالحة؛ راجع ملاحظات قراءة SAP. لم يُرسل شيء للجندي.'+warning);
        return;
      }
      try{
        const imported=await enqueue(result.transfers,stored.key);
        setMessage(saved+'أُضيف '+imported.added+' ترحيلًا لقائمة الجندي؛ '+imported.existing+
          ' موجودة مسبقًا؛ '+imported.skipped+
          ' حركات مستبعدة من الجندي (عكسي/كاش فان/إلغاء/غير صالحة). لم تُنشأ فاتورة زرقاء.'+
          reclassified+warning);
      }catch(cause){
        setMessage(saved+'تمت قراءة '+result.transfers.length+' ترحيلًا، لكن تعذّر تحديث قائمة الجندي. '+
          (cause instanceof Error?cause.message:'أعد الفحص لاحقًا.')+' لم تُحذف النسخة المحفوظة.'+warning);
      }
    }catch(cause){
      setError(cause instanceof Error?cause.message:'تعذّر حفظ ملف الملازم أول.');
    }finally{setBusy(false)}
  }

  async function stampStockDate(stock:StockSnapshot,stockKind:'balance'|'opening'){
    const date=stockKind==='balance'?stockQueryDate:from;
    if(!sapStockBalanceQuery(date)||date>todayLocal()){
      setError('اختر تاريخ الرصيد الحقيقي؛ لا يمكن اعتماد تاريخ مستقبلي.');return;
    }
    if(!window.confirm('هل هذا الكشف من SAP يمثل '+(stockKind==='balance'?'الرصيد الفعلي بنهاية':'الرصيد قبل أول حركة بتاريخ')+
      ' '+date+'؟ سيتم حفظ نسخة مؤرخة جديدة دون حذف القديمة.'))return;
    const file=files.find(row=>row.key===stock.key);
    if(!file){setError('حدث قائمة الأرشيف أولًا، ثم حاول تثبيت التاريخ.');return;}
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/lieutenant-files?key='+encodeURIComponent(stock.key),
        {cache:'no-store',redirect:'manual'});
      if(!response.ok)throw Error('تعذّر فتح الملف الأصلي لتثبيت التاريخ.');
      const stored=await checkedJson<{key:string}>('/api/lieutenant-files',{
        method:'POST',headers:{
          'Content-Type':'application/octet-stream',
          'X-File-Name':encodeURIComponent(file.name),
          'X-File-Kind':stockKind,'X-Snapshot-Date':date,
        },body:await response.arrayBuffer(),
      });
      const changed={...stock,key:stored.key,date};
      if(stockKind==='balance'){
        setClosing(changed);setTo(date);setStockDate(null);setStockCopyMessage('');
      }else setOpening(changed);
      setSelected(stored.key);await refreshFiles();
      setMessage('تم تثبيت تاريخ '+date+' في نسخة جديدة من أرشيف '+fileKinds[stockKind]+
        '. بقي الملف القديم محفوظًا دون تغيير.');
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر تثبيت تاريخ الرصيد.');}
    finally{setBusy(false);}
  }

  async function auditAgain(){
    if(!selectedTransfer||!transfers.length)return;
    setBusy(true);setError('');
    try{
      const result=await enqueue(transfers,selectedTransfer);
      setMessage('اكتمل تحديث الرقابة: '+result.added+' ترحيلًا جديدًا؛ '+result.existing+
        ' محفوظًا مسبقًا؛ '+result.skipped+' مستبعدًا من جندي الفواتير (عكسي/كاش فان/ملغى أو غير صالح).');
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر تحديث الفحص.')}
    finally{setBusy(false)}
  }

  return <div>
    <div className="page-title"><div><p className="eyebrow">رقابة المستودع 011</p>
      <h1>الملازم أول — مراقبة الترحيلات والفواتير</h1>
      <p>كل ملفات SAP محفوظة في أرشيف Supabase؛ يرسل الترحيلات غير المسجلة للجندي دون إنشاء فاتورة أو اعتمادها.</p></div>
      <ShieldCheck size={32}/></div>
    <section className="panel" aria-label="الأرصدة الافتتاحية المعتمدة">
      <div className="section-title"><div><h2>الأرصدة الافتتاحية المعتمدة — المستودع 011</h2>
        <p>الرصيد المسجل قبل أول حركة في تاريخ البداية. يُحتسب في التدقيق ولا يُسجل كترحيل أو فاتورة.</p></div></div>
      {snapshot.openingStock.length>0?
        <div className="table-scroll"><table><thead><tr>
          <th>تاريخ الرصيد</th><th>كود الصنف</th><th>اسم الصنف</th><th>المستودع</th><th>الوحدة</th><th>الرصيد الافتتاحي</th><th>الاعتماد</th>
        </tr></thead><tbody>{snapshot.openingStock.map(row=><tr key={row.snapshot_date+'|'+row.warehouse+'|'+row.sap_code+'|'+row.unit}>
          <td dir="ltr">{row.snapshot_date}</td><td dir="ltr"><b>{row.sap_code}</b></td><td>{row.item_name}</td>
          <td dir="ltr">{row.warehouse}</td><td>{row.unit==='Piece'?'حبة':row.unit}</td>
          <td><strong dir="ltr">{Number(row.quantity).toFixed(3)}</strong></td>
          <td><span className="badge match"><CheckCircle2 size={13}/>معتمد</span></td>
        </tr>)}</tbody></table></div>:
        <p className="hint">لم تظهر أرصدة افتتاحية معتمدة من قاعدة البيانات بعد.</p>}
      <p className="hint">الرصيد الافتتاحي وحده لا يثبت مطابقة SAP؛ يجب إضافة جميع حركات الفترة والرصيد الفعلي بنهايتها.</p>
    </section>
    <section className="panel sap-stock-query no-print" aria-labelledby="sap-stock-query-title">
      <div className="section-title"><div><h2 id="sap-stock-query-title">كويري SAP — رصيد المستودع 011</h2>
        <p>رصيد نهاية اليوم من جميع حركات المخزون في OINM حتى التاريخ المحدد، بما فيها الحركات السابقة للشهر. تبقى الأصناف ذات الرصيد الصفري في النتيجة.</p>
      </div></div>
      <div className="table-controls sap-stock-query-controls">
        <label>تاريخ الرصيد — نهاية اليوم<input type="date" dir="ltr" value={stockQueryDate}
          onChange={event=>{setStockDate(event.target.value);setStockCopyMessage('')}}/></label>
        <button type="button" className="button primary" disabled={!stockQuery} onClick={()=>void copyStockQuery()}>
          <Copy size={16}/> نسخ الكويري</button>
        {stockDate!==null&&stockDate!==to&&<button type="button" className="button secondary" onClick={()=>{
          setStockDate(null);setStockCopyMessage('');
        }}>استخدام «إلى تاريخ»</button>}
      </div>
      <p className="hint">يتبع حقل «إلى تاريخ» تلقائيًا، ويمكن اختيار يوم آخر للكويري. تغيير «إلى تاريخ» يعيد ربط الكويري به.</p>
      <textarea ref={stockQueryRef} aria-label="كويري SAP لرصيد المستودع 011" dir="ltr" readOnly
        spellCheck={false} wrap="off" rows={17} value={stockQuery}/>
      {!stockQuery&&<p role="alert" className="red">اختر تاريخًا صالحًا لإنشاء الكويري ونسخه.</p>}
      {stockCopyMessage&&<p role="status" className="sap-stock-copy-status">{stockCopyMessage}</p>}
      <p className="sap-stock-query-instructions">انسخ الكويري إلى SAP، شغّله، صدّر النتيجة إلى Excel، ثم ارفعها للملازم أول تحت نوع الملف: رصيد 011 الفعلي في نهاية الفترة.</p>
      <p className="hint">هذا رصيد فعلي بنهاية اليوم المختار، ويشمل حركات ذلك اليوم. الرصيد الافتتاحي في 01/11 هو الرصيد قبل أول حركة في ذلك اليوم؛ لا ترفع نتيجة هذا الكويري كرصيد افتتاحي.</p>
    </section>
    <section className="panel">
      <div className="section-title"><div><h2>أرشيف ملفات الملازم أول</h2>
        <p>تُقرأ الأعمدة لتصنيف الترحيلات والأرصدة تلقائيًا. يحتفظ Supabase بكل ملف أصلي ولا يحوّل الأرصدة إلى فواتير.</p></div></div>
      <div className="table-controls">
        <label>نوع الملف المتوقع (يُصحّح تلقائيًا)
          <select value={kind} disabled={busy} onChange={event=>setKind(event.target.value as FileKind)}>
            {Object.entries(fileKinds).map(([id,title])=><option value={id} key={id}>{title}</option>)}
          </select>
        </label>
        <label className="button primary"><FileUp size={16}/> إرفاق وحفظ في قاعدة البيانات
          <input type="file" disabled={busy} onChange={upload} style={{display:'none'}}/>
        </label>
        <button className="button secondary" disabled={busy} type="button" onClick={async()=>{
          setBusy(true);setError('');
          try{await Promise.all([refreshFiles(),refreshSnapshot()])}
          catch(cause){setError(cause instanceof Error?cause.message:'تعذّر التحديث.')}
          finally{setBusy(false)}
        }}><RefreshCw size={16}/> تحديث الأرشيف</button>
      </div>
      <p className="hint">عند رفع كشف رصيد فعلي يُحفظ تاريخ اللقطة من «تاريخ الرصيد — نهاية اليوم» أعلى الشاشة. والرصد الافتتاحي يأخذ «من تاريخ». راجع التاريخ قبل الرفع؛ تاريخ الحفظ ليس تاريخ الرصيد.</p>
      {files.length?<div className="table-scroll"><table><thead><tr><th>الملف المحفوظ</th><th>نوعه</th><th>تاريخ الرصيد</th><th>تاريخ الحفظ</th><th>فتح</th><th>حذف</th></tr></thead>
        <tbody>{files.map(file=><tr key={file.key}><td dir="auto">{file.name}</td>
          <td>{fileKinds[file.kind]||file.kind}</td><td dir="ltr">{file.snapshotDate||'—'}</td>
          <td dir="ltr">{file.created?.slice(0,16).replace('T',' ')||'—'}</td>
          <td><button type="button" disabled={busy} className="button secondary small" onClick={()=>void readArchive(file)}>
            <FileArchive size={14}/>{selected===file.key?'مفتوح':'فتح من الأرشيف'}</button></td>
          <td><button type="button" disabled={busy} className="button secondary small"
            aria-label={'حذف '+file.name+' من الأرشيف'} onClick={()=>void deleteArchive(file)}>
            <Trash2 size={14}/> حذف</button></td>
        </tr>)}</tbody></table></div>:<p className="hint">لم يُرفع ملف بعد إلى أرشيف الملازم أول.</p>}
      {nextPage!==null&&<button type="button" disabled={busy} className="button secondary" onClick={()=>void refreshFiles(nextPage)}>إظهار ملفات أقدم</button>}
      {error&&<p role="alert" className="banner error"><AlertTriangle size={16}/> {error}</p>}
      {message&&<p role="status" className="banner info">{message}</p>}
    </section>
    <section className="panel" aria-label="مقارنة رصيد 011 الفعلي">
      <div className="section-title"><div><h2>رصيد 011 الفعلي — مقارنة الترحيلات والفواتير</h2>
        <p>اللقطة من كويري OINM، والترحيلات من كشف SAP، والكميات المعتمدة من الفواتير الزرقاء المحفوظة.</p></div></div>
      {!closing?<p className="hint">ارفع كشف الرصيد الفعلي أو افتحه من أرشيف الملازم أول لعرض الأصناف ومقارنتها.</p>:<>
        <div className="stats">
          <div className="stat"><span>أصناف كشف الرصيد</span><strong>{closing.items.length}</strong></div>
          <div className="stat"><span>تاريخ الرصيد</span><strong>{closing.date||'غير محدد'}</strong></div>
          <div className="stat"><span>الترحيلات المحمّلة</span><strong>{transfers.length}</strong></div>
        </div>
        {!closing.date&&<button className="button secondary" type="button" disabled={busy}
          onClick={()=>void stampStockDate(closing,'balance')}>
          تثبيت تاريخ هذا الرصيد على {stockQueryDate} وحفظ نسخة مؤرخة
        </button>}
        {!canCompare&&<div role="alert" className="banner warn"><AlertTriangle size={16}/>
          <div>
            {!closing.date?'تاريخ كشف الرصيد غير مثبت. ثبّت تاريخ الرصيد الفعلي أولًا.':
            !selectedTransfer?
              (autoLoading?'جارٍ استعادة ترحيلات SAP المحفوظة من الأرشيف...':
              'كشف الرصيد جاهز، لكن ملف ترحيلات SAP غير مفتوح. افتح ملف الحركات من الأرشيف، وليس كشف الرصيد مرة ثانية.'):
            to!==closing.date?'تاريخ نهاية الفترة ('+to+') لا يطابق تاريخ كشف الرصيد ('+closing.date+').':
            from>to?'تاريخ البداية بعد تاريخ النهاية.':'تحقق من ملف الترحيلات والفترة.'}
            {closing.date&&to!==closing.date&&<button type="button" className="button secondary small"
              onClick={()=>{setTo(closing.date);setStockDate(null);setStockCopyMessage('')}}>
              مطابقة «إلى تاريخ» مع {closing.date}
            </button>}
          </div>
        </div>}
        {closing.issues.length>0&&<div className="banner warn" role="alert">
          <strong>ملاحظات كشف الرصيد ({closing.issues.length}):</strong>
          <ul>{closing.issues.slice(0,10).map((note,i)=><li key={i}>{note}</li>)}</ul></div>}
        {!snapshotLoaded&&<p className="banner warn">قاعدة المطابقات لم تُحمّل؛ عمود الفواتير المعتمدة غير متاح حاليًا، وليس صفرًا.</p>}
        <p className="hint">«المتوقع» = الرصيد الافتتاحي المعتمد + صافي الترحيلات فقط، وليس بديلًا عن سجل جميع حركات OINM. إذا كان الرصيد الافتتاحي ناقصًا أو اختلفت الوحدات، لا يُفترض صفر ولا يُختلق فرق. الكميات المرتبطة بالفواتير هي وارد الترحيلات المعتمدة المؤكد ورقها، ولا تُستخدم بدل الرصيد.</p>
        <div className="table-scroll"><table><thead><tr>
          <th>كود SAP</th><th>اسم الصنف</th><th>الوحدة</th><th>الافتتاحي</th>
          <th>وارد الترحيلات</th><th>صادر / عكسي</th><th>صافي الترحيلات</th>
          <th>وارد فواتيره معتمدة</th><th>المتوقع من الترحيلات</th><th>رصيد SAP الفعلي</th><th>الفرق التفسيري</th>
        </tr></thead><tbody>{stockRows.map(item=><tr key={item.code+'|'+item.unit}>
          <td dir="ltr"><b>{item.code}</b></td><td>{item.name}</td><td>{item.unit}</td>
          <td dir="ltr">{canCompare&&item.opening!==null?item.opening.toFixed(3):'—'}</td>
          <td dir="ltr">{canCompare?item.incoming.toFixed(3):'—'}</td>
          <td dir="ltr">{canCompare?item.outgoing.toFixed(3):'—'}</td>
          <td dir="ltr">{canCompare?item.netTransfers.toFixed(3):'—'}</td>
          <td dir="ltr">{canCompare&&snapshotLoaded?item.approvedIncoming.toFixed(3):'—'}</td>
          <td dir="ltr">{canCompare&&item.estimated!==null?item.estimated.toFixed(3):'—'}</td>
          <td dir="ltr"><strong>{item.quantity.toFixed(3)}</strong></td>
          <td dir="ltr">{canCompare&&item.difference!==null?item.difference.toFixed(3):'—'}</td>
        </tr>)}</tbody></table></div>
      </>}
    </section>
    <section className="panel">
      <div className="section-title"><div><h2>تدقيق الفترة المطلوبة</h2>
        <p>الفترة تحدد نتائج التقرير، ولا تحذف أو تخفي أي ترحيل من قاعدة البيانات.</p></div></div>
      <div className="form-grid">
        <label>من تاريخ<input type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label>
        <label>إلى تاريخ<input type="date" value={to} onChange={event=>{
          setTo(event.target.value);setStockDate(null);setStockCopyMessage('');
        }}/></label>
        <label>البحث<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="رقم الترحيل أو الفرع"/></label>
      </div>
      <div className="table-controls">
        <button className="button primary" disabled={busy||!transfers.length||from>to}
          onClick={()=>void auditAgain()}><Search size={16}/> تحديث الفحص وإرسال الناقص للجندي</button>
        <select aria-label="فلترة ترحيلات الملازم أول" value={filter} onChange={event=>setFilter(event.target.value)}>
          <option value="pending">المطلوبة فقط (بدون العكسي المسوّى)</option>
          <option value="all">الكل</option>
          {Object.entries(statusText).map(([key,text])=><option key={key} value={key}>{text}</option>)}
        </select>
      </div>
      {selectedTransfer&&<p className="hint">مصدر الترحيلات الحالي: <strong>{transferSourceName}</strong>
        — {transfers.length} ترحيلًا من الملف. إذا كانت الترحيلات موزعة على عدة ملفات، استخدم كشفًا شاملًا للفترة.
        فتح الأرشيف للقراءة فقط ولا ينشئ فواتير.</p>}
      <div className="stats">
        <div className="stat"><span>ترحيلات الفترة</span><strong>{rows.length}</strong></div>
        <div className="stat"><span>مطابقة ومعتمدة</span><strong>{counts.approved}</strong></div>
        <div className="stat"><span>بانتظار الجندي</span><strong>{counts.queued}</strong></div>
        <div className="stat"><span>تحتاج متابعة</span><strong>{counts.pending}</strong></div>
      </div>
      {issues.length>0&&<div className="banner warn" role="alert"><AlertTriangle size={17}/>
        <div><strong>{issues.length} ملاحظة على قراءة SAP:</strong>
          <ul>{issues.slice(0,12).map((issue,i)=><li key={i}>{issue}</li>)}</ul></div>
      </div>}
      {!selectedTransfer?<p className="hint">{autoLoading?'جارٍ تحميل ترحيلات SAP من الأرشيف...':
        files.some(file=>file.kind==='transfers')?
        'لم يتم فتح كشف ترحيلات صالح بعد. اضغط «فتح من الأرشيف» بجانب ملف الترحيلات الصحيح؛ كشف الأرصدة ليس كشف حركات.':
        'لا يوجد ملف ترحيلات مؤرشف. صدّر حركات المستودع 011 من SAP وارفعها مرة واحدة.'}</p>:
        !transfers.length?<p className="hint">هذا الملف ليس كشف ترحيلات صالحًا للمراجعة، أو لم يُفتح كشف ترحيلات بعد.</p>:
      <div className="table-scroll"><table><thead><tr>
        <th>رقم الترحيل</th><th>التاريخ</th><th>الفرع</th><th>اتجاه الحركة</th><th>الحالة</th><th>تفاصيل</th><th>فتح</th>
      </tr></thead><tbody>{visible.map(row=><tr key={row.source.transfer.number}>
        <td dir="ltr"><b>{row.source.transfer.number}</b></td>
        <td dir="ltr">{row.source.transfer.date}</td><td>{row.source.branch||'غير محدد'}</td>
        <td>{row.source.reverse?'صادر من 011':'وارد إلى 011'}</td>
        <td><span className={'badge '+(completeStatuses.has(row.status)?'match':row.status==='review'||row.status==='missing'?'difference':'review')}>
          {completeStatuses.has(row.status)?<CheckCircle2 size={13}/>:<AlertTriangle size={13}/>}
          {statusText[row.status]}</span>
          {row.source.cancellationState==='canceled'&&<small style={{display:'block'}}>حالة SAP: ترحيل ملغى (Y)</small>}
          {row.source.cancellationState==='cancellation'&&<small style={{display:'block'}}>حالة SAP: مستند إلغاء (C)</small>}
          {row.source.cancellationState==='unknown'&&<small style={{display:'block'}}>حالة الإلغاء غير مذكورة</small>}
          {row.source.cancellationMentioned&&row.source.cancellationState==='unknown'&&<small style={{display:'block'}}>Remarks تذكر إلغاء دون إثبات</small>}</td>
        <td>{row.note}</td>
        <td>{row.recordId?<button type="button" className="button secondary small" onClick={()=>onOpenRecord(row.recordId!)}>فتح الفاتورة</button>:
          <button type="button" className="button secondary small" disabled={!soldierEligible(row.status)||!!row.source.issues.length} onClick={()=>onOpenTransfer(row.source.transfer,row.source.branch)}>{soldierEligible(row.status)?'إرسال للجندي':'ليس لفاتورة زرقاء'}</button>}</td>
      </tr>)}</tbody></table></div>}
      {selectedTransfer&&transfers.length>0&&!visible.length&&<p className="hint">لا توجد ترحيلات بهذه الفلاتر.</p>}
      {counts.review>0&&<p className="hint">هناك {counts.review} حركة تحتاج تدقيق العكسي أو الإلغاء أو بيانات المصدر. العكسي المطابق ليس إلغاء SAP؛ لا يُرسل كاش فان للجندي لمجرد عدم وجود فاتورة زرقاء.</p>}
    </section>
    <MovementSummary rows={rows}/>
  </div>;
}
