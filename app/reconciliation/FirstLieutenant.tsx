'use client';

import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import {AlertTriangle,CheckCircle2,Copy,FileArchive,FileUp,RefreshCw,Search,ShieldCheck,Trash2} from 'lucide-react';
import {decodeLieutenantFile} from '../lib/lieutenant-file';
import {parseLieutenantTransfers,type LieutenantTransfer} from '../lib/lieutenant';
import {analyzeLieutenantMovements} from '../lib/lieutenant-counterparts';
import {invoiceDocumentNo,transferNumbers,type Draft,type Transfer,type Item} from '../lib/reconcile';
import {readSavedSapImport,type SavedSapImport} from '../lib/saved-sap-import';
import {restoreLieutenantSource,restoreLieutenantStock,sharedLieutenantKey,type LieutenantSourceFile} from '../lib/lieutenant-source';
import {lieutenantApprovals} from '../lib/lieutenant-coverage';
import {auditInvoicesForDay,type DayInvoiceData,type DayInvoiceState} from '../lib/lieutenant-invoice-day';
import {sapStockBalanceQuery} from '../lib/sap-stock-query';
import {auditLieutenantStock,classifyLieutenantContent,parseLieutenantStock,
  type StockItem,type StockAuditItem,type LieutenantFileKind} from '../lib/lieutenant-stock';

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
const stockUnit=(value:string)=>({Piece:'حبة',Carton:'كرتونة',KG:'كغم'}[value]||value);
/** Inventory reconciliation is transfer-only until an OINM movement journal is
 * supplied. Do not invent a specific cause for a non-zero balance variance. */
function explainStockDifference(item:StockAuditItem,canCompare:boolean):string{
  if(!canCompare)return 'بانتظار كشف ترحيلات SAP ورصيد فعلي مؤرّخ بنهاية الفترة.';
  if(item.opening===null)return 'الرصيد الافتتاحي غير مثبت أو وحدة تحويله غير معرّفة؛ لا يمكن تفسير الفرق.';
  if(item.quantity===null)return 'لا يوجد رصيد فعلي مثبت لهذا الصنف في كشف SAP.';
  if(!item.movementComplete)return 'ترحيلات أو وحدات غير مكتملة؛ راجع ملاحظات الصنف قبل حساب الفرق.';
  if(item.difference===null)return 'المقارنة غير مكتملة؛ لا يجوز اعتبار البيانات الناقصة صفرًا.';
  if(Math.abs(item.difference)<0.000001)return 'مطابق بين الرصيد الفعلي وحساب الافتتاحي وصافي الترحيلات.';
  const direction=item.difference>0?'زيادة في رصيد SAP':'نقص في رصيد SAP';
  return direction+' بمقدار '+Math.abs(item.difference).toFixed(3)+' '+stockUnit(item.unit)+
    ' عن المتوقع من الترحيلات. السبب التفصيلي غير مثبت: افحص حركات OINM الأخرى (بيع، صرف، تسوية أو جرد) وأرقام مستنداتها.';
}
const dailyStateNames:Record<DayInvoiceState,string>={
  match:'مطابقة',late:'مطابقة — ترحيل متأخر',pending:'بانتظار الترحيل',
  short:'نقص في الترحيل',extra:'كمية زائدة',
  review:'تحتاج مراجعة بيانات',
};
// Local calendar day, not UTC, because SAP stock is dated by posting day.
function todayLocal():string{
  const value=new Date();
  return value.getFullYear()+'-'+String(value.getMonth()+1).padStart(2,'0')+'-'+
    String(value.getDate()).padStart(2,'0');
}
async function fetchArchivedSource(file:LieutenantSourceFile){
  const response=await fetch('/api/lieutenant-files?key='+encodeURIComponent(file.key),
    {cache:'no-store',redirect:'manual'});
  if(response.status===401||response.type==='opaqueredirect')
    throw Error('انتهت جلسة الدخول. سجّل دخولك من جديد.');
  if(!response.ok)throw Error('تعذّر قراءة ترحيلات الأرشيف: HTTP '+response.status);
  return decodeLieutenantFile(await response.arrayBuffer(),file.name);
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
function makeRows(transfers:LieutenantTransfer[],snapshot:RecordSnapshot,periodEnd:string,approvals:ReturnType<typeof lieutenantApprovals>):ReviewRow[]{
  const movements=analyzeLieutenantMovements(transfers,periodEnd);
  const saved=new Map<string,{id:string;status:ReviewStatus;note:string}>();
  for(const record of snapshot.records){
    let draft:Draft;
    try{draft=JSON.parse(record.payload) as Draft;
      if(!draft||!Array.isArray(draft.invoices)||!Array.isArray(draft.transfers))continue;
    }catch{continue}
    const numbers=(draft.invoices||[]).map(inv=>invoiceDocumentNo(inv.number)).filter(Boolean);
    const hasPaper=numbers.length>0&&(draft.invoices||[]).every(inv=>!!invoiceDocumentNo(inv.number)&&inv.complete);
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
    if(result)return {source,status:approvals.warnings.has(number)?'linked':result.status,
      recordId:result.id,note:approvals.warnings.get(number)||result.note};
    if(queue.has(number))return {source,status:'queued',note:'محفوظ مستقلًا عن الفواتير؛ لم تُنشأ فاتورة تلقائية.'};
    return {source,status:'missing',note:'الترحيل موجود في ملف SAP، لكن ليس في السجل ولا قائمة الجندي.'};
  });
}

function MovementSummary({rows}:{rows:ReviewRow[]}){
  const movements=useMemo(()=>{
    const totals=new Map<string,{code:string;unit:string;inward:number;outward:number;adjustment:number}>();
    for(const {source} of rows){
      if(source.issues.length||['canceled','cancellation'].includes(source.cancellationState))continue;
      for(const line of source.transfer.paste.split('\n').slice(1)){
        const [code,,quantity,unit,from,to]=line.split('\t');
        const qty=Number(quantity.replace(/,/g,''));
        if(!code||!Number.isFinite(qty))continue;
        const key=code+'|'+unit;
        const item=totals.get(key)||{code,unit,inward:0,outward:0,adjustment:0};
        if(qty<0){
          if(to==='011'&&from!=='011')item.adjustment+=qty;
          else if(from==='011'&&to!=='011')item.adjustment-=qty;
        }else if(to==='011'&&from!=='011')item.inward+=qty;
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
    <div className="table-scroll"><table><thead><tr><th>كود SAP</th><th>الوحدة</th><th>الوارد</th><th>الصادر</th><th>أثر التصحيحات الموقّع</th><th>صافي الحركة</th></tr></thead><tbody>
      {movements.map(row=><tr key={row.code+'|'+row.unit}><td dir="ltr">{row.code}</td><td>{row.unit}</td><td>{row.inward}</td><td>{row.outward}</td><td>{row.adjustment}</td><td>{Number((row.inward-row.outward+row.adjustment).toFixed(6))}</td></tr>)}
    </tbody></table></div>
  </details>;
}

export default function FirstLieutenant({branches,reference,onOpenTransfer,onOpenRecord}:{
  branches:string[];
  reference:Item[];
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
  const [autoLoading,setAutoLoading]=useState(true);
  const [sharedSource,setSharedSource]=useState<SavedSapImport|null>(null);
  const [transferSourceName,setTransferSourceName]=useState('');
  const [importProgress,setImportProgress]=useState('');
  const [invoiceDay,setInvoiceDay]=useState(()=>todayLocal().slice(0,8)+'01');
  const [invoiceAsOf,setInvoiceAsOf]=useState(todayLocal);
  const [dailyInvoices,setDailyInvoices]=useState<DayInvoiceData|null>(null);
  const [dailyLoading,setDailyLoading]=useState(false);
  const [dailyError,setDailyError]=useState('');
  const [rowLimit,setRowLimit]=useState(50);
  const transferSelectedRef=useRef(false);
  const closingSelectedRef=useRef(false);
  const openingSelectedRef=useRef(false);
  const periodEditedRef=useRef(false);
  const unreadableRecords=useMemo(()=>snapshot.records.filter(record=>{
    try{const value=JSON.parse(record.payload);return !value||!Array.isArray(value.invoices)||!Array.isArray(value.transfers)}
    catch{return true}
  }).length,[snapshot.records]);
  const recordsReady=snapshotLoaded&&unreadableRecords===0;

  async function inspectInvoiceDay(){
    if(!sapStockBalanceQuery(invoiceDay)||!sapStockBalanceQuery(invoiceAsOf)||
      invoiceDay>invoiceAsOf||invoiceAsOf>todayLocal()){
      setDailyError('اختر تاريخ الفاتورة وتاريخ فحص صحيحين؛ الفحص لا يكون قبل الفاتورة أو بعد اليوم.');
      return;
    }
    setDailyLoading(true);setDailyError('');setDailyInvoices(null);
    try{
      const data=await checkedJson<DayInvoiceData>(
        '/api/reconcile?lieutenantInvoiceDay='+encodeURIComponent(invoiceDay));
      if(!Array.isArray(data.rows)||!Array.isArray(data.records))
        throw Error('استجابة فحص الفواتير ليست بالإصدار المتوقع؛ تحقق من نشر آخر نسخة للسيرفر.');
      setDailyInvoices(data);
    }catch(cause){
      setDailyError(cause instanceof Error?cause.message:'تعذّر قراءة الفواتير الزرقاء المحفوظة.');
    }finally{setDailyLoading(false)}
  }
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
  async function restoreTransfers(candidates:StoredFile[],isActive=()=>true){
    setAutoLoading(true);
    try{
      const source=await restoreLieutenantSource(candidates,branches,fetchArchivedSource,readSavedSapImport);
      if(!isActive()||transferSelectedRef.current)return;
      if(!source)return;
      transferSelectedRef.current=true;
      setSelectedTransfer(source.key);setTransferSourceName(source.name);
      setSharedSource(source.shared||null);
      setTransfers(source.scan.transfers);setIssues(source.scan.issues);
      if(source.shared)setMessage('تمت استعادة كشف SAP المحفوظ: '+source.scan.transfers.length+
        ' ترحيلًا. الملف متاح للمقارنة دون إعادة رفعه. لم تُنشأ فاتورة أو تُعتمد بيانات.');
    }finally{if(isActive())setAutoLoading(false);}
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
          closingSelectedRef.current=true;
          setClosing(stock);
          if(date){setTo(date);setStockDate(null);setStockCopyMessage('');}
        }else{openingSelectedRef.current=true;setOpening(stock);}
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
      setSharedSource(null);
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
      if(state.status==='fulfilled'){
        setSnapshot(state.value);setSnapshotLoaded(true);
      }else{
        errors.push(state.reason instanceof Error?state.reason.message:'تعذّر تحميل بيانات المطابقة.');
      }
      if(archive.status==='fulfilled'){
        setFiles(archive.value.files);setNextPage(archive.value.nextPage);
      }else{
        errors.push(archive.reason instanceof Error?archive.reason.message:'تعذّر تحميل أرشيف الملازم أول.');
      }
      const archivedFiles=archive.status==='fulfilled'?archive.value.files:[];
      const sources=await Promise.allSettled([
        restoreTransfers(archivedFiles,()=>active),
        restoreLieutenantStock(archivedFiles,'balance',todayLocal(),fetchArchivedSource).then(result=>{
          if(!active||!result||closingSelectedRef.current)return;
          closingSelectedRef.current=true;
          setClosing({key:result.file.key,date:result.file.snapshotDate!,...result.stock});
          setSelected(result.file.key);
          if(!periodEditedRef.current){setTo(result.file.snapshotDate!);setStockDate(null);}
        }),
        restoreLieutenantStock(archivedFiles,'opening',from,fetchArchivedSource).then(result=>{
          if(!active||!result||openingSelectedRef.current)return;
          openingSelectedRef.current=true;
          setOpening({key:result.file.key,date:result.file.snapshotDate!,...result.stock});
        }),
      ]);
      for(const result of sources)if(result.status==='rejected')
        errors.push(result.reason instanceof Error?result.reason.message:'تعذّر استعادة أحد ملفات الرقابة.');
      if(active&&errors.length)setError(errors.join(' '));
    }
    void init();
    return()=>{active=false};
  },[]);

  const dailyReport=useMemo(()=>
    dailyInvoices&&selectedTransfer&&transfers.length?
      auditInvoicesForDay(dailyInvoices,transfers,invoiceAsOf,reference):null,
    [dailyInvoices,selectedTransfer,transfers,invoiceAsOf,reference]);
  const dailyCounts=useMemo(()=>{
    const totals={match:0,late:0,pending:0,short:0,extra:0,review:0};
    for(const row of dailyReport?.rows||[])totals[row.state]++;
    return totals;
  },[dailyReport]);
  const dailySkuTotals=useMemo(()=>{
    const totals=new Map<string,{code:string;name:string;expected:number;posted:number;uncertain:boolean}>();
    for(const invoice of dailyReport?.rows||[])for(const item of invoice.items){
      const total=totals.get(item.code)||{
        code:item.code,name:item.name,expected:0,posted:0,uncertain:false,
      };
      total.expected+=(item.expected??0);total.posted+=(item.posted??0);
      total.uncertain ||= invoice.state==='review'||item.expected===null||item.posted===null;
      totals.set(item.code,total);
    }
    return [...totals.values()].sort((a,b)=>a.uncertain===b.uncertain?
      Math.abs(b.expected-b.posted)-Math.abs(a.expected-a.posted):a.uncertain?1:-1);
  },[dailyReport]);
  const approvals=useMemo(()=>lieutenantApprovals(transfers,snapshot.records),[transfers,snapshot.records]);
  const rows=useMemo(()=>makeRows(transfers,snapshot,to,approvals).filter(row=>
    row.source.transfer.date>=from&&row.source.transfer.date<=to),[transfers,snapshot,from,to,approvals]);
  const pending=rows.filter(row=>!completeStatuses.has(row.status));
  const visible=rows.filter(row=>(filter==='all'||(filter==='pending'?!completeStatuses.has(row.status):row.status===filter))&&
    (!query||[row.source.transfer.number,row.source.branch,row.source.remarks,row.note].some(value=>value.includes(query))));
  const counts=useMemo(()=>({
    approved:rows.filter(row=>row.status==='approved').length,
    queued:rows.filter(row=>row.status==='queued').length,
    review:rows.filter(row=>row.status==='review'||row.status==='cashvan-pending'||row.status==='cancellation-review').length,
    pending:pending.length,
  }),[rows,pending.length]);
  const approvedTransferNumbers=approvals.approved;
  const periodValid=!!sapStockBalanceQuery(from)&&!!sapStockBalanceQuery(to)&&from<=to&&to<=todayLocal();
  const canCompare=!!closing?.date&&closing.date===to&&!!selectedTransfer&&periodValid;
  const invoiceRequiredNumbers=useMemo(()=>{
    const movements=analyzeLieutenantMovements(transfers,to);
    return new Set(transfers.filter(row=>!row.reverse&&movements.get(row.transfer.number)?.kind==='normal')
      .map(row=>row.transfer.number));
  },[transfers,to]);
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
      canCompare?transfers:[],canCompare?approvedTransferNumbers:new Set<string>(),from,to,
      reference,invoiceRequiredNumbers);
  },[closing,opening,snapshot.openingStock,from,to,transfers,approvedTransferNumbers,canCompare,reference,invoiceRequiredNumbers]);
  const coverageReady=canCompare&&recordsReady;
  const uncoveredItems=stockRows.filter(item=>item.uncoveredIncoming!==null&&item.uncoveredIncoming>0.000001);
  const incompleteItems=stockRows.filter(item=>!item.movementComplete);
  const [stockQueryText,setStockQueryText]=useState('');
  const [stockFilter,setStockFilter]=useState('all');
  const visibleStockRows=stockRows.filter(item=>(!coverageReady||stockFilter==='all'||
    (stockFilter==='uncovered'?item.uncoveredIncoming!==null&&item.uncoveredIncoming>0.000001:
    stockFilter==='incomplete'?!item.movementComplete:item.movementComplete&&item.requiredIncoming>0&&item.uncoveredIncoming===0))&&
    (!stockQueryText||(item.code+' '+item.name).toLowerCase().includes(stockQueryText.trim().toLowerCase())));

  async function enqueue(source:LieutenantTransfer[],key:string){
    // Cash Van, the exact reverse, SAP-canceled and cancellation documents
    // are inventory-control cases, not missing blue invoices.
    const movements=analyzeLieutenantMovements(source,to);
    const inPeriod=source.filter(row=>row.transfer.date>=from&&row.transfer.date<=to);
    const valid=inPeriod.filter(row=>!row.issues.length&&movements.get(row.transfer.number)?.kind==='normal');
    const skipped=inPeriod.length-valid.length;
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
    for(const [index,payload] of batches.entries()){
      setImportProgress('جارٍ تحديث ترحيلات الفترة: دفعة '+(index+1)+' من '+batches.length+'…');
      const result=await checkedJson<{added:number;existing:number}>('/api/reconcile',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'lieutenantImport',sourceFile:key,transfers:payload}),
      });
      added+=result.added;existing+=result.existing;
    }
    await refreshSnapshot();
    setImportProgress('');
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
          closingSelectedRef.current=true;
          setClosing(stock);setTo(date);setStockDate(null);setStockCopyMessage('');
        }else{openingSelectedRef.current=true;setOpening(stock);}
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
      setSharedSource(null);
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
    }finally{setBusy(false);setImportProgress('')}
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
      let sourceKey=selectedTransfer;
      if(sourceKey===sharedLieutenantKey&&sharedSource){
        // Freeze a separate copy before import; never replace current.json.
        const stored=await checkedJson<{key:string}>('/api/lieutenant-files',{
          method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8',
            'X-File-Name':encodeURIComponent(sharedSource.name),'X-File-Kind':'transfers'},
          body:new TextEncoder().encode(sharedSource.text),
        });
        sourceKey=stored.key;setSelectedTransfer(sourceKey);setSharedSource(null);
        await refreshFiles();
      }
      const result=await enqueue(transfers,sourceKey);
      setMessage('اكتمل تحديث الرقابة: '+result.added+' ترحيلًا جديدًا؛ '+result.existing+
        ' محفوظًا مسبقًا؛ '+result.skipped+' مستبعدًا من جندي الفواتير (عكسي/كاش فان/ملغى أو غير صالح).');
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر تحديث الفحص.')}
    finally{setBusy(false);setImportProgress('')}
  }

  return <div>
    <div className="page-title"><div><p className="eyebrow">رقابة المستودع 011</p>
      <h1>الملازم أول — مراقبة الترحيلات والفواتير</h1>
      <p>كل ملفات SAP محفوظة في أرشيف Supabase؛ يرسل الترحيلات غير المسجلة للجندي دون إنشاء فاتورة أو اعتمادها.</p></div>
      <ShieldCheck size={32}/></div>
    <section className="panel" aria-label="فترة رقابة المستودع 011">
      <div className="section-title"><div><h2>الفترة المطلوبة للمقارنة</h2>
        <p>ابدأ من أول الشهر، واختر نهاية الفترة بنفس تاريخ كشف رصيد SAP. تتحدث الترحيلات والمقارنة حسب هذه الفترة.</p></div></div>
      <div className="form-grid">
        <label>من تاريخ<input type="date" value={from} max={todayLocal()} onChange={event=>{periodEditedRef.current=true;setFrom(event.target.value);setRowLimit(50)}}/></label>
        <label>إلى تاريخ<input type="date" value={to} max={todayLocal()} onChange={event=>{
          periodEditedRef.current=true;setTo(event.target.value);setStockDate(null);setStockCopyMessage('');setRowLimit(50);
        }}/></label>
      </div>
      {!periodValid&&<p className="banner warn" role="alert">اختر تاريخ بداية ونهاية صحيحين؛ تاريخ البداية لا يتجاوز النهاية، والنهاية لا تتجاوز اليوم.</p>}
    </section>
    <section className="panel" aria-label="مطابقة الفواتير الزرقاء حسب تاريخ الفاتورة">
      <div className="section-title"><div>
        <h2>فحص يوم الفواتير الزرقاء — هل ترحّلت الكميات على SAP؟</h2>
        <p>اختر يوم إصدار الفواتير، ثم تاريخ فحص ترحيلاتها. يعتمد الفحص المطابقة التي حفظتها ويبيّن تاريخ الترحيل وتأخره. تُفحص أصناف وكميات الفواتير غير المعتمدة حسب البيانات المتاحة.</p>
      </div></div>
      <div className="table-controls no-print">
        <label>تاريخ الفواتير الزرقاء
          <input type="date" dir="ltr" value={invoiceDay} max={todayLocal()}
            onChange={event=>{setInvoiceDay(event.target.value);setDailyInvoices(null);setDailyError('')}}/>
        </label>
        <label>فحص الترحيلات حتى نهاية
          <input type="date" dir="ltr" value={invoiceAsOf} min={invoiceDay} max={todayLocal()}
            onChange={event=>{setInvoiceAsOf(event.target.value);setDailyError('')}}/>
        </label>
        <button className="button primary" type="button"
          disabled={dailyLoading||!sapStockBalanceQuery(invoiceDay)||!sapStockBalanceQuery(invoiceAsOf)||
            invoiceDay>invoiceAsOf||invoiceAsOf>todayLocal()}
          onClick={()=>void inspectInvoiceDay()}><Search size={16}/>
          {dailyLoading?'جارٍ فحص الفواتير...':'فحص جميع فواتير هذا اليوم'}
        </button>
      </div>
      <p className="hint">الفواتير التي حفظتها «مطابق ماليًا» تظهر «مطابقة» حسب اعتمادك، دون طلب الكميات أو توزيع الصفحات من جديد. يظهر تأخر الترحيل بجانب المطابقة، ولا تدخل كميات الترحيلات اللاحقة لتاريخ الفحص.</p>
      {dailyError&&<p className="banner error" role="alert"><AlertTriangle size={16}/>{dailyError}</p>}
      {dailyInvoices&&!selectedTransfer&&<p className="banner warn" role="alert">
        بيانات الفواتير جاهزة، لكن ملف ترحيلات SAP لم يُسترجع بعد. افتح كشف الترحيلات من الأرشيف؛ لا يكفي كشف الرصيد الفعلي وحده.
      </p>}
      {dailyInvoices&&selectedTransfer&&!dailyReport&&<p className="banner warn" role="alert">
        مصدر ترحيلات SAP لا يحتوي حركات قابلة للفحص.
      </p>}
      {dailyReport&&dailyInvoices&&<>
        <p className="hint">المصدر: <b>{transferSourceName}</b> · أحدث تاريخ حركة ظاهر في الملف: <b dir="ltr">{dailyReport.sourceLastDate||'غير معروف'}</b>.
          لا يمكن إثبات عدم وجود ترحيلات جديدة بعد أحدث تاريخ يغطيه الملف.</p>
        {dailyInvoices.unreadableRecords>0&&<p className="banner warn" role="alert">
          يوجد {dailyInvoices.unreadableRecords} سجل غير قابل للقراءة في قاعدة الفواتير؛ النتائج لا تشمل هذه السجلات.
        </p>}
        {dailyInvoices.undatedInvoices>0&&<p className="hint">يوجد {dailyInvoices.undatedInvoices} فاتورة بلا تاريخ يمكن التحقق منه على مستوى السجل، ولم تُنسب تلقائيًا إلى اليوم المختار.</p>}
        {dailyInvoices.inferredDates>0&&<p className="hint">{dailyInvoices.inferredDates} فاتورة في هذا اليوم تاريخها مستنتج من تاريخ ترحيل SAP ناقص يومًا، وليس تاريخ فاتورة مؤكّدًا يدويًا.</p>}
        <div className="stats">
          <div className="stat"><span>فواتير اليوم</span><strong>{dailyReport.rows.length}</strong></div>
          <div className="stat"><span>مطابقة</span><strong>{dailyCounts.match+dailyCounts.late}</strong></div>
          <div className="stat"><span>منها ترحيل متأخر</span><strong>{dailyCounts.late}</strong></div>
          <div className="stat"><span>بانتظار ترحيل</span><strong>{dailyCounts.pending}</strong></div>
          <div className="stat"><span>نقص أو زيادة مثبت</span><strong>{dailyCounts.short+dailyCounts.extra}</strong></div>
          <div className="stat"><span>تحتاج مراجعة بيانات</span><strong>{dailyCounts.review}</strong></div>
        </div>
        {dailyReport.rows.length>0&&dailyCounts.match+dailyCounts.late===dailyReport.rows.length&&
          <p><span className="badge match"><CheckCircle2 size={14}/> جميع فواتير اليوم مطابقة؛ الترحيلات المتأخرة معلّمة بوضوح.</span></p>}
        {dailySkuTotals.length>0&&<details className="lieutenant-stock-details">
          <summary>إجمالي الأصناف لجميع فواتير اليوم ({dailySkuTotals.length} صنف)</summary>
          <p className="hint">تجميع بالكود المعتمد للمؤسسة وبالحبة. الكميات التفصيلية غير المسجلة تُعرض بشرطة (—)، ولا تغيّر اعتماد الفواتير المحفوظ.</p>
          <div className="table-scroll"><table><thead><tr>
            <th>رقم صنف المؤسسة</th><th>الصنف</th><th>كمية الفواتير (حبة)</th>
            <th>المرحل حتى تاريخ الفحص (حبة)</th><th>الفرق</th><th>الحالة</th>
          </tr></thead><tbody>{dailySkuTotals.map(item=><tr key={item.code}>
            <td dir="ltr">{item.code}</td><td>{item.name}</td>
            <td dir="ltr">{item.uncertain?'—':item.expected.toFixed(3)}</td>
            <td dir="ltr">{item.uncertain?'—':item.posted.toFixed(3)}</td>
            <td dir="ltr">{item.uncertain?'—':(item.expected-item.posted).toFixed(3)}</td>
            <td>{item.uncertain?'الكميات التفصيلية غير مكتملة':
              Math.abs(item.expected-item.posted)<0.000001?'مطابق':'يوجد فرق'}</td>
          </tr>)}</tbody></table></div>
        </details>}
        {!dailyReport.rows.length?<p className="hint">لا توجد فواتير زرقاء مؤرّخة في هذا اليوم ضمن السجلات التي أمكن قراءتها.</p>:
        <div className="table-scroll"><table>
          <thead><tr><th>الفاتورة الزرقاء</th><th>الفرع</th><th>تاريخ الفاتورة</th>
            <th>ترحيلات SAP المرتبطة</th><th>تاريخ الترحيل</th><th>الحالة</th><th>تفاصيل الأصناف والفرق</th>
          </tr></thead>
          <tbody>{dailyReport.rows.map((result,index)=><tr key={result.recordId+'|'+result.number+'|'+index}>
            <td dir="ltr"><strong>{result.number}</strong></td>
            <td>{result.branch}</td><td dir="ltr">{result.invoiceDate}</td>
            <td dir="ltr">{result.transferNumbers.join('، ')||'غير مثبت'}</td>
            <td dir="ltr">{result.postedDates.join('، ')||'—'}</td>
            <td><span className={'badge '+(
              result.state==='match'||result.state==='late'?'match':
              result.state==='short'||result.state==='extra'?'difference':'review')}>
              {dailyStateNames[result.state]}</span></td>
            <td><details><summary>عرض الأصناف ({result.items.length})</summary>
              {result.notes.length>0&&<ul>{result.notes.map(note=><li key={note}>{note}</li>)}</ul>}
              {result.items.length>0&&<table><thead><tr>
                <th>رقم المؤسسة</th><th>الصنف</th><th>كمية الفاتورة (حبة)</th>
                <th>المرحل إلى 011 حتى الفحص (حبة)</th><th>الفرق (فاتورة − SAP)</th>
              </tr></thead><tbody>{result.items.map(item=><tr key={item.code}>
                <td dir="ltr">{item.code}</td><td>{item.name}</td>
                <td dir="ltr">{item.expected===null?'—':item.expected.toFixed(3)}</td>
                <td dir="ltr">{item.posted===null?'—':item.posted.toFixed(3)}</td>
                <td dir="ltr">{item.difference===null?'—':item.difference.toFixed(3)}</td>
              </tr>)}</tbody></table>}
            </details></td>
          </tr>)}</tbody></table></div>}
        <p className="hint">الشرطة (—) تعني أن الكمية التفصيلية غير مسجلة، ولا تعني صفرًا. تبقى الفاتورة «مطابقة» حسب اعتمادك المالي المحفوظ، مع إظهار تاريخ ترحيل SAP والملاحظات في التفاصيل.</p>
        <p className="hint">الفحص للقراءة فقط ويحترم اعتمادك المحفوظ، ولا يعدّل الفواتير أو أرشيف SAP. الفواتير غير المعتمدة تُفحص حسب الأصناف والكميات المتاحة. حركة SAP بتاريخ الترحيل، وليس بتاريخ الفاتورة.</p>
      </>}
    </section>
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
          max={todayLocal()} onChange={event=>{periodEditedRef.current=true;setStockDate(event.target.value);setStockCopyMessage('')}}/></label>
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
          try{
            const results=await Promise.allSettled([refreshFiles(),refreshSnapshot()]);
            if(results[0].status==='fulfilled'&&!selectedTransfer)
              await restoreTransfers(results[0].value);
            const failed=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
            if(failed.length)setError(failed.map(result=>result.reason instanceof Error?result.reason.message:'تعذّر التحديث.').join(' '));
          }
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
      {nextPage!==null&&<button type="button" disabled={busy} className="button secondary" onClick={async()=>{
        setBusy(true);setError('');
        try{await refreshFiles(nextPage)}catch(cause){setError(cause instanceof Error?cause.message:'تعذّر تحميل الملفات الأقدم.')}
        finally{setBusy(false)}
      }}>إظهار ملفات أقدم</button>}
      {error&&<p role="alert" className="banner error"><AlertTriangle size={16}/> {error}</p>}
      {message&&<p role="status" className="banner info">{message}</p>}
      {importProgress&&<p role="status" className="banner info">{importProgress}</p>}
      {opening&&<div className="banner info"><div>
        كشف افتتاحي مفتوح: {opening.items.length} صنفًا · تاريخ الرصيد: {opening.date||'غير محدد'}.
        {!opening.date&&<button type="button" className="button secondary small" disabled={busy}
          onClick={()=>void stampStockDate(opening,'opening')}>تثبيت تاريخ الافتتاحي على {from}</button>}
        {opening.issues.map(note=><p className="red" key={note}>{note}</p>)}
      </div></div>}
    </section>
    <section className="panel" aria-label="مقارنة رصيد 011 الفعلي">
      <div className="section-title"><div><h2>رصيد 011 الفعلي — مقارنة الترحيلات والفواتير</h2>
        <p>اختر الفترة من أول الشهر حتى تاريخ الرصيد. تُقارن الترحيلات بالفواتير المشيّكة والمعتمدة، ويظهر رصيد SAP الفعلي لكل صنف بشكل مستقل.</p></div></div>
      {!closing?<p className="hint">ارفع كشف الرصيد الفعلي أو افتحه من أرشيف الملازم أول لعرض الأصناف ومقارنتها.</p>:<>
        <div className="stats">
          <div className="stat"><span>أصناف كشف الرصيد</span><strong>{closing.items.length}</strong></div>
          <div className="stat"><span>تاريخ الرصيد</span><strong>{closing.date||'غير محدد'}</strong></div>
          <div className="stat"><span>الترحيلات المحمّلة</span><strong>{transfers.length}</strong></div>
          <div className="stat"><span>أصناف بحاجة فواتير معتمدة</span><strong>{coverageReady?uncoveredItems.length:'—'}</strong></div>
          <div className="stat"><span>أصناف تحتاج مراجعة البيانات</span><strong>{canCompare?incompleteItems.length:'—'}</strong></div>
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
            !periodValid?'اختر فترة صحيحة لا تنتهي بتاريخ مستقبلي.':'تحقق من ملف الترحيلات والفترة.'}
            {closing.date&&to!==closing.date&&<button type="button" className="button secondary small"
              onClick={()=>{setTo(closing.date);setStockDate(null);setStockCopyMessage('')}}>
              مطابقة «إلى تاريخ» مع {closing.date}
            </button>}
          </div>
        </div>}
        {closing.issues.length>0&&<div className="banner warn" role="alert">
          <strong>ملاحظات كشف الرصيد ({closing.issues.length}):</strong>
          <ul>{closing.issues.slice(0,10).map((note,i)=><li key={i}>{note}</li>)}</ul></div>}
        {!recordsReady&&<p className="banner warn">قاعدة المطابقات لم تُقرأ بالكامل؛ عمود الفواتير المعتمدة غير متاح حاليًا، وليس صفرًا.</p>}
        <p className="hint">«غير مغطى بفواتير معتمدة» = الوارد الذي يحتاج فاتورة − الوارد المغطى بفواتير مشيّكة ومعتمدة ومؤكد ورقها. لا تدخل حركات الكاش فان أو الإلغاء أو العكسي المسوّى بالكامل ضمن المطلوب له فواتير. هذه المقارنة لا تثبت أن الفاتورة رُحّلت على SAP.</p>
        <p className="hint">«المتوقع من الترحيلات» = الافتتاحي + الوارد − الصادر + أثر التصحيحات الموقّع. مطابقة رصيد المستودع النهائية تحتاج جميع حركات المخزون OINM، بما فيها البيع والتسويات. تُوحّد الوحدات فقط بشدّات وأوزان معرفة في مرجع الأصناف؛ البيانات الناقصة تظهر «—» ولا تُحسب صفرًا.</p>
        <div className="table-controls no-print">
          <label>بحث في الأصناف<input type="search" value={stockQueryText} onChange={event=>setStockQueryText(event.target.value)} placeholder="كود SAP أو اسم الصنف"/></label>
          <label>عرض الأصناف<select value={stockFilter} disabled={!coverageReady} onChange={event=>setStockFilter(event.target.value)}>
            <option value="all">كل الأصناف</option><option value="uncovered">بحاجة فواتير معتمدة</option>
            <option value="covered">مغطاة بفواتير معتمدة</option><option value="incomplete">بيانات تحتاج مراجعة</option>
          </select></label>
        </div>
        <div className="table-scroll"><table className="lieutenant-stock-table"><thead><tr>
          <th>الصنف</th><th>الوحدة</th><th>رصيد SAP الفعلي</th><th>صافي الترحيلات</th>
          <th>وارد يحتاج فاتورة</th><th>مرتبط بفواتير معتمدة</th><th>غير مغطى بفواتير معتمدة</th><th>حالة تغطية الفواتير</th><th>تفسير فرق الرصيد</th>
        </tr></thead><tbody>{visibleStockRows.map(item=><tr key={item.code+'|'+item.unit}>
          <td className="name-cell"><b dir="ltr">{item.code}</b><small>{item.name}</small></td><td>{stockUnit(item.unit)}</td>
          <td dir="ltr"><strong>{item.quantity===null?'—':item.quantity.toFixed(3)}</strong></td>
          <td dir="ltr">{canCompare&&item.movementComplete?item.netTransfers.toFixed(3):'—'}</td>
          <td dir="ltr">{canCompare&&item.movementComplete?item.requiredIncoming.toFixed(3):'—'}</td>
          <td dir="ltr">{coverageReady&&item.movementComplete?item.approvedIncoming.toFixed(3):'—'}</td>
          <td dir="ltr">{coverageReady&&item.uncoveredIncoming!==null?item.uncoveredIncoming.toFixed(3):'—'}</td>
          <td>{!coverageReady?'بانتظار اكتمال مصادر المقارنة':!item.movementComplete?'بيانات ناقصة':
            item.requiredIncoming===0?'لا يوجد وارد يحتاج فاتورة':item.uncoveredIncoming===0?'مغطى بفواتير معتمدة':'بحاجة متابعة'}
            {item.converted&&<small style={{display:'block'}}>وُحّدت الكميات حسب مرجع الأصناف</small>}
            {item.issues.map(note=><small className="red" style={{display:'block'}} key={note}>{note}</small>)}
          </td>
          <td>{explainStockDifference(item,canCompare)}</td>
        </tr>)}</tbody></table></div>
        {!visibleStockRows.length&&<p className="hint">لا توجد أصناف بهذه الفلاتر.</p>}
        <details className="lieutenant-stock-details"><summary>تفاصيل الافتتاحي والوارد والعكسي والتصحيحات</summary>
          <p className="hint">الفرق التفسيري هو رصيد SAP − (الافتتاحي + صافي الترحيلات). لا يمثل حكمًا نهائيًا على صحة رصيد المستودع دون سجل جميع حركات المخزون.</p>
          <div className="table-scroll"><table><thead><tr>
            <th>كود SAP</th><th>الوحدة</th><th>الافتتاحي</th><th>الوارد</th><th>الصادر / العكسي</th>
            <th>أثر التصحيحات الموقّع</th><th>المتوقع من الترحيلات</th><th>رصيد SAP الفعلي</th><th>الفرق التفسيري</th><th>سبب الفرق / ما يلزم إثباته</th>
          </tr></thead><tbody>{visibleStockRows.map(item=><tr key={item.code+'|'+item.unit}>
            <td dir="ltr">{item.code}</td><td>{stockUnit(item.unit)}</td>
            <td dir="ltr">{canCompare&&item.opening!==null?item.opening.toFixed(3):'—'}</td>
            <td dir="ltr">{canCompare&&item.movementComplete?item.incoming.toFixed(3):'—'}</td>
            <td dir="ltr">{canCompare&&item.movementComplete?item.outgoing.toFixed(3):'—'}</td>
            <td dir="ltr">{canCompare&&item.movementComplete?item.adjustment.toFixed(3):'—'}</td>
            <td dir="ltr">{canCompare&&item.estimated!==null?item.estimated.toFixed(3):'—'}</td>
            <td dir="ltr">{item.quantity===null?'—':item.quantity.toFixed(3)}</td>
            <td dir="ltr">{canCompare&&item.difference!==null?item.difference.toFixed(3):'—'}</td>
            <td>{explainStockDifference(item,canCompare)}</td>
          </tr>)}</tbody></table></div>
        </details>
      </>}
    </section>
    <section className="panel">
      <div className="section-title"><div><h2>تدقيق الفترة المطلوبة</h2>
        <p>الفترة تحدد نتائج التقرير، ولا تحذف أو تخفي أي ترحيل من قاعدة البيانات.</p></div></div>
      <p className="hint">الفترة المختارة: <b dir="ltr">{from} — {to}</b> · غيّر الفترة من أعلى الشاشة.</p>
      <div className="table-controls">
        <label>البحث<input type="search" value={query} onChange={event=>{setQuery(event.target.value);setRowLimit(50)}} placeholder="رقم الترحيل أو الفرع"/></label>
        <button className="button primary" disabled={busy||autoLoading||!transfers.length||!periodValid}
          onClick={()=>void auditAgain()}><Search size={16}/> تحديث الفحص وإرسال الناقص للجندي</button>
        <select aria-label="فلترة ترحيلات الملازم أول" value={filter} onChange={event=>{setFilter(event.target.value);setRowLimit(50)}}>
          <option value="pending">المطلوبة فقط (بدون العكسي المسوّى)</option>
          <option value="all">الكل</option>
          {Object.entries(statusText).map(([key,text])=><option key={key} value={key}>{text}</option>)}
        </select>
      </div>
      {!recordsReady&&<p className="banner warn" role="alert">{unreadableRecords?
        'هناك '+unreadableRecords+' سجل مطابقة غير قابل للقراءة. لا يمكن تأكيد تغطية الفواتير قبل مراجعته.':
        'حالات الفواتير لم تُحمّل بعد؛ لا تُعتبر الترحيلات مفقودة أو غير معتمدة قبل اكتمال القراءة. استخدم «تحديث الأرشيف» لإعادة المحاولة.'}</p>}
      {selectedTransfer&&<p className="hint">مصدر الترحيلات الحالي: <strong>{transferSourceName}</strong>
        — {transfers.length} ترحيلًا من الملف. إذا كانت الترحيلات موزعة على عدة ملفات، استخدم كشفًا شاملًا للفترة.
        فتح الأرشيف للقراءة فقط ولا ينشئ فواتير.</p>}
      <div className="stats">
        <div className="stat"><span>ترحيلات الفترة</span><strong>{selectedTransfer&&periodValid?rows.length:'—'}</strong></div>
        <div className="stat"><span>مطابقة ومعتمدة</span><strong>{selectedTransfer&&recordsReady&&periodValid?counts.approved:'—'}</strong></div>
        <div className="stat"><span>بانتظار الجندي</span><strong>{selectedTransfer&&recordsReady&&periodValid?counts.queued:'—'}</strong></div>
        <div className="stat"><span>تحتاج متابعة</span><strong>{selectedTransfer&&recordsReady&&periodValid?counts.pending:'—'}</strong></div>
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
      </tr></thead><tbody>{visible.slice(0,rowLimit).map(row=><tr key={row.source.transfer.number}>
        <td dir="ltr"><b>{row.source.transfer.number}</b></td>
        <td dir="ltr">{row.source.transfer.date}</td><td>{row.source.branch||'غير محدد'}</td>
        <td>{row.source.reverse?'صادر من 011':'وارد إلى 011'}</td>
        <td><span className={'badge '+(completeStatuses.has(row.status)?'match':row.status==='review'||row.status==='missing'?'difference':'review')}>
          {completeStatuses.has(row.status)?<CheckCircle2 size={13}/>:<AlertTriangle size={13}/>}
          {recordsReady?statusText[row.status]:'حالة الفاتورة غير متاحة'}</span>
          {row.source.cancellationState==='canceled'&&<small style={{display:'block'}}>حالة SAP: ترحيل ملغى (Y)</small>}
          {row.source.cancellationState==='cancellation'&&<small style={{display:'block'}}>حالة SAP: مستند إلغاء (C)</small>}
          {row.source.cancellationState==='unknown'&&<small style={{display:'block'}}>حالة الإلغاء غير مذكورة</small>}
          {row.source.cancellationMentioned&&row.source.cancellationState==='unknown'&&<small style={{display:'block'}}>Remarks تذكر إلغاء دون إثبات</small>}</td>
        <td>{recordsReady?row.note:'تعذّر قراءة سجل المطابقات بالكامل؛ لا يمكن تحديد تغطية هذا الترحيل بعد.'}</td>
        <td>{row.recordId?<button type="button" className="button secondary small" onClick={()=>onOpenRecord(row.recordId!)}>فتح الفاتورة</button>:
          <button type="button" className="button secondary small" disabled={!recordsReady||!soldierEligible(row.status)||!!row.source.issues.length} onClick={()=>onOpenTransfer(row.source.transfer,row.source.branch)}>{soldierEligible(row.status)?'إرسال للجندي':'ليس لفاتورة زرقاء'}</button>}</td>
      </tr>)}</tbody></table></div>}
      {visible.length>rowLimit&&<button type="button" className="button secondary" onClick={()=>setRowLimit(value=>value+100)}>
        إظهار ترحيلات إضافية ({Math.min(rowLimit,visible.length)} من {visible.length})
      </button>}
      {selectedTransfer&&transfers.length>0&&!visible.length&&<p className="hint">لا توجد ترحيلات بهذه الفلاتر.</p>}
      {counts.review>0&&<p className="hint">هناك {counts.review} حركة تحتاج تدقيق العكسي أو الإلغاء أو بيانات المصدر. العكسي المطابق ليس إلغاء SAP؛ لا يُرسل كاش فان للجندي لمجرد عدم وجود فاتورة زرقاء.</p>}
    </section>
    <MovementSummary rows={rows}/>
  </div>;
}
