'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {readSapArchive,listSapFiles} from '../lib/sap-files-client';
import CashVanAudit from './CashVanAudit';
import CancelledTransferReview from './CancelledTransferReview';
import {AlertTriangle,CheckCircle2,Copy,RefreshCw,Search,ShieldCheck} from 'lucide-react';
import {type LieutenantTransfer} from '../lib/lieutenant';
import {analyzeLieutenantMovements} from '../lib/lieutenant-counterparts';
import {invoiceDocumentNo,readReconciliationRecord,transferNumbers,type Draft,type Transfer,type Item} from '../lib/reconcile';
import {readSavedSapImport} from '../lib/saved-sap-import';
import {restoreLieutenantSource,restoreLieutenantStock,sharedLieutenantKey,type LieutenantSourceFile} from '../lib/lieutenant-source';
import {lieutenantApprovals} from '../lib/lieutenant-coverage';
import {auditInvoicesForDay,type DayInvoiceData,type DayInvoiceState,type DaySapStatus} from '../lib/lieutenant-invoice-day';
import {sapStockBalanceQuery} from '../lib/sap-stock-query';
import {auditLieutenantStock,completeOpeningSnapshot,stockMovementSources,
  type StockItem,type StockAuditItem,type LieutenantFileKind} from '../lib/lieutenant-stock';

type FileKind=LieutenantFileKind;
type StoredFile={key:string;name:string;kind:FileKind;size:number;created:string;snapshotDate?:string};
type StockSnapshot={key:string;date:string;items:StockItem[];issues:string[]};
type SavedRecord={id:string;branch:string;status:string;payload:string};
type QueueRecord={transfer_no:string;doc_date:string;payload:string;source_file:string;created:string};
type OpeningStock={snapshot_date:string;warehouse:string;sap_code:string;item_name:string;unit:string;quantity:number;source:string;approved_at:string};
type RecordSnapshot={records:SavedRecord[];queue:QueueRecord[];openingStock:OpeningStock[]};
type ReviewStatus='approved'|'paper'|'linked'|'unlinked'|'queued'|'missing'|'review'|'reversed'|'reverse'|'sap-canceled'|'sap-cancel-doc'|'cashvan-pending'|'cancellation-review';
type ReviewRow={source:LieutenantTransfer;status:ReviewStatus;recordId?:string;note:string;counterparts?:string[]};

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
  unlinked:'ترحيل فقط — سجل بلا فاتورة زرقاء',
  queued:'ترحيل SAP مستقل — لدى الملازم أول',
  missing:'ترحيل SAP غير منسوب — لدى الملازم أول',
  review:'يحتاج مراجعة بيانات SAP',
  reversed:'تمت التسوية بعكسي مطابق',
  reverse:'ترحيل عكسي — بلا فاتورة مستقلة',
  'sap-canceled':'ملغى رسميًا على SAP',
  'sap-cancel-doc':'مستند إلغاء SAP',
  'cashvan-pending':'كاش فان — عكسي/إلغاء غير مثبت',
  'cancellation-review':'إلغاء يحتاج تحقق',
};
const empty:RecordSnapshot={records:[],queue:[],openingStock:[]};
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
    ' عن المتوقع من الترحيلات. تفاصيل العكسي والإلغاء موجودة أسفل الصنف؛ لا يُثبت سبب الفرق إلا بمستند مطابق.';
}
type StockEvidence={
  number:string;date:string;kind:string;direction:string;quantity:number;unit:string;effect:number|null;
  counted:boolean;counterpart?:string;note:string;
};
/** Scan SAP source documents rather than attributing every residual balance
 * difference to a reverse/cancellation without supporting document evidence. */
function stockDifferenceEvidence(
  transfers:LieutenantTransfer[],periodFrom:string,periodTo:string,
):Map<string,StockEvidence[]>{
  const result=new Map<string,StockEvidence[]>();
  const movement=analyzeLieutenantMovements(transfers,periodTo);
  const warehouse=(value:string)=>/^\d+$/.test(value.trim())?
    value.trim().padStart(3,'0'):value.trim();
  for(const source of stockMovementSources(transfers)){
    const number=source.transfer.number,date=source.transfer.date;
    if(!date||date<periodFrom||date>periodTo)continue;
    const status=movement.get(number);
    const kind=source.cancellationState==='canceled'?'ترحيل ملغى في SAP':
      source.cancellationState==='cancellation'?'مستند إلغاء SAP':
      source.signedAdjustment?'تصحيح كمية سالبة':
      source.reverse?'ترحيل عكسي':
      status?.kind==='sap-canceled'?'ترحيل أصلي مقابل إلغاء':
      status?.kind==='reversed'?'ترحيل أصلي له عكسي مطابق':
      status?.kind==='cashvan-pending'?'كاش فان دون تسوية مثبتة':
      status?.kind==='cancellation-review'?'حالة إلغاء تحتاج مراجعة':'ترحيل وارد';
    for(const line of source.transfer.paste.replace(/\r/g,'').split('\n').slice(1)){
      if(!line.trim())continue;
      const [rawCode,,rawQuantity,unit,rawFrom,rawTo]=line.split('\t');
      const code=(rawCode||'').trim().toUpperCase();
      const quantity=Number((rawQuantity||'').replace(/,/g,''));
      const from=warehouse(rawFrom||''),to=warehouse(rawTo||'');
      if(!/^[A-Z]{2,6}\d{3,10}$/.test(code)||!Number.isFinite(quantity)||
        !(from==='011'||to==='011')||from===to)continue;
      const effect=to==='011'?quantity: -quantity;
      const evidence:StockEvidence={number,date,kind,direction:from+' → '+to,quantity,unit:unit||'—',
        effect:source.issues.length?null:effect,
        counted:!source.issues.length,counterpart:status?.counterpart,
        note:source.issues.length?'مستند يحتاج مراجعة بيانات SAP':
          status?.note||source.remarks||''};
      result.set(code,[...(result.get(code)||[]),evidence]);
    }
  }
  for(const docs of result.values())docs.sort((a,b)=>a.date.localeCompare(b.date)||
    a.number.localeCompare(b.number,'en',{numeric:true}));
  return result;
}
const sapDayNames:Record<DaySapStatus,string>={
  posted:'ترحيلات SAP مثبتة حتى الفحص',
  waiting:'الترحيل بعد تاريخ الفحص',
  missing:'مستند SAP غير مثبت',
  reversed:'ترحيل معكوس أو ملغى',
  partial:'عكسي/تصحيح أو تغطية جزئية',
  review:'حركة SAP تحتاج مراجعة',
};
const dailyStateNames:Record<DayInvoiceState,string>={
  match:'مطابقة',late:'مطابقة',pending:'بانتظار الترحيل',
  short:'نقص في الترحيل',extra:'كمية زائدة',
  review:'تحتاج مراجعة بيانات',
  'cashvan-settled':'كاش فان — مسوّى بعكسي/إلغاء',
  'cashvan-pending':'كاش فان — العكسي/الإلغاء غير مكتمل',
};
// Local calendar day, not UTC, because SAP stock is dated by posting day.
function todayLocal():string{
  const value=new Date();
  return value.getFullYear()+'-'+String(value.getMonth()+1).padStart(2,'0')+'-'+
    String(value.getDate()).padStart(2,'0');
}
const fetchArchivedSource=readSapArchive;
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

const completeStatuses=new Set<ReviewStatus>(['approved','linked','paper','reversed','reverse','sap-canceled','sap-cancel-doc']);
// Any unassigned transfer remains with First Lieutenant. Never open an invoice
// group merely because SAP contains a movement with no blue invoice.
function makeRows(transfers:LieutenantTransfer[],snapshot:RecordSnapshot,periodEnd:string,approvals:ReturnType<typeof lieutenantApprovals>):ReviewRow[]{
  const movements=analyzeLieutenantMovements(transfers,periodEnd);
  const saved=new Map<string,{id:string;status:ReviewStatus;note:string}>();
  for(const record of snapshot.records){
    const draft=readReconciliationRecord(record.payload);
    if(!draft)continue;
    const numbers=(draft.invoices||[]).map(inv=>invoiceDocumentNo(inv.number)).filter(Boolean);
    const hasPaper=numbers.length>0&&(draft.invoices||[]).every(inv=>!!invoiceDocumentNo(inv.number)&&inv.complete);
    const matched=record.status==='match'&&hasPaper;
    const status:ReviewStatus=matched?'approved':numbers.length?
      hasPaper?'linked':'paper':'unlinked';
    const note=numbers.length?'منسوب لفاتورة زرقاء: '+numbers.join('، ')+'؛ لا تطلب فاتورة جديدة.':'ترحيل بلا فاتورة زرقاء؛ ليس مجموعة، وتبقى متابعة SAP عند الملازم أول.';
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
      return {source,status:movement.kind,recordId:result?.id,note:movement.note,
        counterparts:movement.counterparts||[movement.counterpart].filter((value):value is string=>!!value)};
    if(result)return {source,status:approvals.warnings.has(number)?'linked':result.status,
      recordId:result.id,note:approvals.warnings.get(number)||result.note};
    if(queue.has(number))return {source,status:'queued',note:'ترحيل SAP مستقل؛ ليس مجموعة فواتير ولا يتطلب فاتورة تلقائيًا.'};
    return {source,status:'missing',note:'ترحيل SAP غير مرتبط بفاتورة؛ متابعة الملازم أول فقط دون إنشاء مجموعة أو طلب فاتورة.'};
  });
}

function MovementSummary({transfers,from,to}:{transfers:LieutenantTransfer[];from:string;to:string}){
  const sources=useMemo(()=>stockMovementSources(transfers).filter(source=>
    source.transfer.date>=from&&source.transfer.date<=to),[transfers,from,to]);
  const incomplete=sources.filter(source=>source.issues.length).length;
  const movements=useMemo(()=>{
    const totals=new Map<string,{code:string;unit:string;inward:number;outward:number;adjustment:number}>();
    for(const source of sources){
      if(source.issues.length)continue;
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
  },[sources]);
  if(!movements.length&&!incomplete)return null;
  return <details className="panel">
    <summary>صافي الحركة حسب كود SAP ووحدة الترحيل ({movements.length})</summary>
    <p className="hint">صافي حركة من الملف حسب تاريخ كل مستند، وليس رصيد SAP الفعلي. تُحتسب مستندات الإلغاء عند إثبات المقابلة الكاملة مع الأصل، حتى لو وقعا في فترتين مختلفتين. لا نجمع KG مع Carton أو Piece.</p>
    {incomplete>0&&<p className="amber" role="alert">يوجد {incomplete} مستندًا غير مكتمل الإثبات؛ الصافي أدناه جزئي ولا يثبت مطابقة الرصيد.</p>}
    <div className="table-scroll"><table><thead><tr><th>كود SAP</th><th>الوحدة</th><th>الوارد</th><th>الصادر</th><th>أثر التصحيحات الموقّع</th><th>صافي الحركة</th></tr></thead><tbody>
      {movements.map(row=><tr key={row.code+'|'+row.unit}><td dir="ltr">{row.code}</td><td>{row.unit}</td><td>{row.inward}</td><td>{row.outward}</td><td>{row.adjustment}</td><td>{Number((row.inward-row.outward+row.adjustment).toFixed(6))}</td></tr>)}
    </tbody></table></div>
  </details>;
}

export default function FirstLieutenant({branches,reference,onOpenTransfer,onOpenRecord,section='transfers'}:{
  branches:string[];
  reference:Item[];
  onOpenTransfer:(transfer:Transfer,branch:string)=>void;
  onOpenRecord:(id:string)=>void;
  section?:'transfers'|'day'|'balance'|'opening'|'query'|'cashvan'|'cancellations';
}){
  const [files,setFiles]=useState<StoredFile[]>([]);
  const [selectedTransfer,setSelectedTransfer]=useState('');
  const [closing,setClosing]=useState<StockSnapshot|null>(null);
  const [opening,setOpening]=useState<StockSnapshot|null>(null);
  const [transfers,setTransfers]=useState<LieutenantTransfer[]>([]);
  const [issues,setIssues]=useState<string[]>([]);
  const [snapshot,setSnapshot]=useState<RecordSnapshot>(empty);
  const [snapshotLoaded,setSnapshotLoaded]=useState(false);
  const [aqabaSummary,setAqabaSummary]=useState<{officialInvoices:number;blueInvoices:number;unlinkedOfficial:number;unlinkedBlue:number;cancellationRows:number;transferDocuments:number;journalMovements:number}|null>(null);
  useEffect(()=>{
    fetch('/api/aqaba?summary=1',{cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error('لم يفتح سجل العقبة');
      return response.json() as Promise<{
        officialInvoices:number;blueInvoices:number;unlinkedOfficial:number;unlinkedBlue:number;
        cancellationRows:number;transferDocuments:number;journalMovements:number}>;
    }).then(data=>setAqabaSummary(data)).catch(()=>setAqabaSummary(null));
  },[]);
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
  const [transferSourceName,setTransferSourceName]=useState('');
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
  async function refreshFiles(){
    const next=await listSapFiles() as StoredFile[];setFiles(next);return next;
  }
  async function restoreTransfers(candidates:StoredFile[],isActive=()=>true,force=false){
    setAutoLoading(true);
    try{
      const source=await restoreLieutenantSource(candidates,branches,fetchArchivedSource,readSavedSapImport);
      if(!isActive()||(transferSelectedRef.current&&!force))return;
      if(!source)return;
      transferSelectedRef.current=true;
      setSelectedTransfer(source.key);setTransferSourceName(source.name);
      setTransfers(source.scan.transfers);setIssues(source.scan.issues);
      if(source.shared||force)setMessage((force?'تم تحديث الرقابة من أحدث أرشيف SAP: ':'تمت استعادة كشف SAP المحفوظ: ')+
        source.scan.transfers.length+' مستندًا، المصدر: '+source.name+'. لم تُنشأ فاتورة أو تُعتمد بيانات.');
    }finally{if(isActive())setAutoLoading(false);}
  }
  async function reloadAuditFromArchive(){
    setBusy(true);setError('');setMessage('');
    try{
      const latest=await refreshFiles();
      if(!latest.some(file=>file.kind==='transfers'))
        throw Error('لا يوجد كشف ترحيلات SAP محفوظ في الأرشيف. ارفع الملف الجديد في شاشة «ملفات SAP».');
      await restoreTransfers(latest,()=>true,true);
    }catch(cause){
      setError(cause instanceof Error?cause.message:'تعذّر إعادة تحميل كشف SAP من الأرشيف.');
    }finally{setBusy(false);}
  }
  useEffect(()=>{
    let active=true;
    async function init(){
      const [archive,state]=await Promise.allSettled([
        listSapFiles().then(files=>({files:files as StoredFile[]})),
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
        setFiles(archive.value.files);
      }else{
        errors.push(archive.reason instanceof Error?archive.reason.message:'تعذّر تحميل «ملفات SAP».');
      }
      const archivedFiles=archive.status==='fulfilled'?archive.value.files:[];
      const sources=await Promise.allSettled([
        restoreTransfers(archivedFiles,()=>active),
        restoreLieutenantStock(archivedFiles,'balance',todayLocal(),fetchArchivedSource).then(result=>{
          if(!active||!result||closingSelectedRef.current)return;
          closingSelectedRef.current=true;
          setClosing({key:result.file.key,date:result.file.snapshotDate!,...result.stock});
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
    const totals:Record<DayInvoiceState,number>={match:0,late:0,pending:0,short:0,extra:0,review:0,
      'cashvan-settled':0,'cashvan-pending':0};
    for(const row of dailyReport?.rows||[])totals[row.state]++;
    return totals;
  },[dailyReport]);
  const dailyInvoiceCount=(dailyReport?.rows||[]).filter(row=>!row.cashVan).length;
  const dailySapCounts=useMemo(()=>{
    const totals:Record<DaySapStatus,number>={posted:0,waiting:0,missing:0,reversed:0,partial:0,review:0};
    for(const row of dailyReport?.rows||[])if(!row.cashVan&&row.sapStatus)totals[row.sapStatus]++;
    return totals;
  },[dailyReport]);
  const inspectedSapDocuments=useMemo(()=>transfers.filter(item=>
    item.transfer.date>invoiceDay&&item.transfer.date<=invoiceAsOf).length,
    [transfers,invoiceDay,invoiceAsOf]);
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
    // A saved, explicitly numbered blue invoice creates an invoice obligation.
    // Unassigned SAP movements never become invoice groups automatically.
    const assigned=new Set<string>();
    if(recordsReady)for(const record of snapshot.records){
      const draft=readReconciliationRecord(record.payload);
      if(!draft||!draft.invoices.some(invoice=>!!invoiceDocumentNo(invoice.number)))continue;
      for(const item of draft.transfers)
        for(const number of transferNumbers(item.number||''))assigned.add(number);
    }
    const movements=analyzeLieutenantMovements(transfers,to);
    return new Set(transfers.filter(row=>assigned.has(row.transfer.number)&&!row.reverse&&
      movements.get(row.transfer.number)?.kind==='normal')
      .map(row=>row.transfer.number));
  },[transfers,to,snapshot.records,recordsReady]);
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
    // Individually approved rows prove only their own quantities. Only a full,
    // dated and clean opening export can prove zero for an omitted item.
    const openingConfirmed=completeOpeningSnapshot(opening,from);
    return auditLieutenantStock(closing.items,[...byKey.values()],
      canCompare?transfers:[],canCompare?approvedTransferNumbers:new Set<string>(),from,to,
      reference,invoiceRequiredNumbers,openingConfirmed);
  },[closing,opening,snapshot.openingStock,from,to,transfers,approvedTransferNumbers,canCompare,reference,invoiceRequiredNumbers]);
  const coverageReady=canCompare&&recordsReady;
  const uncoveredItems=stockRows.filter(item=>item.uncoveredIncoming!==null&&item.uncoveredIncoming>0.000001);
  const incompleteItems=stockRows.filter(item=>!item.movementComplete||item.opening===null||item.quantity===null);
  const [stockQueryText,setStockQueryText]=useState('');
  const [stockFilter,setStockFilter]=useState('all');
  const stockEvidence=useMemo(()=>stockDifferenceEvidence(transfers,from,to),[transfers,from,to]);
  const visibleStockRows=stockRows.filter(item=>(!canCompare||stockFilter==='all'||
    (stockFilter==='difference'?item.difference!==null&&Math.abs(item.difference)>0.000001:
    !coverageReady?true:
    stockFilter==='uncovered'?item.uncoveredIncoming!==null&&item.uncoveredIncoming>0.000001:
    stockFilter==='incomplete'?(!item.movementComplete||item.opening===null||item.quantity===null):item.movementComplete&&item.requiredIncoming>0&&item.uncoveredIncoming===0))&&
    (!stockQueryText||(item.code+' '+item.name).toLowerCase().includes(stockQueryText.trim().toLowerCase())));


  return <div>
    <div className="page-title"><div><p className="eyebrow">رقابة المستودع 011</p>
      <h1>{({transfers:'تدقيق الترحيلات',day:'فحص يوم الفواتير الزرقاء',balance:'مطابقة رصيد 011',opening:'الأرصدة الافتتاحية',query:'كويري وأرشيف الرصيد',cashvan:'الكاش فان والترحيلات العكسية',cancellations:'قرارات الإلغاء'} as const)[section]}</h1>
      <p>كل ملفات SAP محفوظة في أرشيف Supabase؛ يرسل الترحيلات غير المسجلة للجندي دون إنشاء فاتورة أو اعتمادها.</p></div>
      <ShieldCheck size={32}/></div>
    {(section==='transfers'||section==='balance')&&<>
    <section className="panel" aria-label="مراقبة مؤسسة العقبة في المستودع المشترك">
      <div className="section-title"><div><h2>مؤسسة العقبة — المستودع 011 المشترك</h2>
        <p>فواتير العقبة الرسمية وترحيلاتها منفصلة عن عمّان. الفاتورة أو التسليم قد يكون سبب خروج البضاعة، لكن لا يجوز خصم أيهما مرة أخرى فوق حركة OINM الفعلية.</p></div></div>
      <p className="hint">{aqabaSummary?'فواتير رسمية: '+aqabaSummary.officialInvoices+' · زرقاء: '+aqabaSummary.blueInvoices+' · ترحيلات العقبة: '+aqabaSummary.transferDocuments+' · حركات OINM محفوظة: '+aqabaSummary.journalMovements+' · سطور إلغاء/إلغاء مقابل: '+aqabaSummary.cancellationRows:'لم يُحمّل ملخص العقبة؛ لا تُعتبر الحركات غير الموجودة صفرًا.'}</p>
      <p className="hint">الربط هنا للمراجعة فقط، ولا يغير معادلة رصيد 011 ولا المطابقات السابقة. يجب توثيق خروج العقبة من OINM وتحديد المستند المقابل قبل إغلاق الفرق.</p>
      <a className="button secondary" href="/reconciliation?view=aqaba">فتح مطابقة مؤسسة العقبة</a>
    </section>
    </>}
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
    <div className="table-controls no-print">
      <button type="button" className="button secondary" onClick={()=>void reloadAuditFromArchive()}
        disabled={busy||autoLoading}>
        {busy||autoLoading?'جارٍ قراءة أرشيف SAP...':'تحديث كشف SAP المستخدم في الرقابة من أحدث الأرشيف'}
      </button>
    </div>
    {(section==='cashvan')&&<>
    <CashVanAudit transfers={transfers} sourceName={transferSourceName||files.find(file=>file.key===selectedTransfer)?.name||''}/>
    </>}
    {(section==='cancellations')&&<>
    <CancelledTransferReview transfers={transfers} from={from} to={to}
      onOpenTransfer={source=>onOpenTransfer(source.transfer,source.branch)}/>
    </>}
    {(section==='day')&&<>
    <section className="panel" aria-label="مطابقة الفواتير الزرقاء حسب تاريخ الفاتورة">
      <div className="section-title"><div>
        <h2>فحص يوم الفواتير الزرقاء — هل ترحّلت الكميات على SAP؟</h2>
        <p>اختر يوم إصدار الفواتير، ثم نهاية فترة فحص SAP. يبقى اعتمادك المالي محفوظًا، ويظهر بجانبه فحص مستقل يقرأ الترحيلات والعكسي والإلغاء والتصحيحات حتى التاريخ المحدد. الأصناف غير المعتمدة تُفحص حسب البيانات المتاحة.</p>
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
      <p className="hint">«مطابقة» تعني اعتمادك المالي المحفوظ ولا تُلغيه هذه الشاشة. عمود «إثبات SAP» منفصل: يفحص وجود الحركات الفعلية والعكسي والإلغاء حتى التاريخ المحدد، ولا يفترض أن الاعتماد المالي يثبت الترحيل أو يعيد طلب توزيع الصفحات.</p>
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
        <p className="hint">فترة تدقيق الحركة: بعد <b dir="ltr">{invoiceDay}</b> وحتى <b dir="ltr">{invoiceAsOf}</b> ·
          {inspectedSapDocuments} مستند SAP ضمن الفترة في ملف الترحيلات الحالي (لكل الفروع).
          لا يعني وجود المستند في الفترة أنه مرتبط بهذه الفاتورة إلا بدليل ربط صريح.</p>
        {dailyReport.rows.some(result=>!result.cashVan&&result.sapStatus!=='posted')&&
          <p className="banner warn" role="status">يوجد اعتماد مالي محفوظ لا يكفي وحده لإثبات ترحيل SAP حتى {invoiceAsOf}.
            راجع عمود «إثبات SAP» والحركات اللاحقة في التفاصيل؛ لم نغيّر اعتماد أي فاتورة.</p>}
        {dailyInvoices.unreadableRecords>0&&<p className="banner warn" role="alert">
          يوجد {dailyInvoices.unreadableRecords} سجل غير قابل للقراءة في قاعدة الفواتير؛ النتائج لا تشمل هذه السجلات.
        </p>}
        {dailyInvoices.undatedInvoices>0&&<p className="hint">يوجد {dailyInvoices.undatedInvoices} فاتورة بلا تاريخ يمكن التحقق منه على مستوى السجل، ولم تُنسب تلقائيًا إلى اليوم المختار.</p>}
        {dailyInvoices.inferredDates>0&&<p className="hint">{dailyInvoices.inferredDates} فاتورة في هذا اليوم تاريخها مستنتج من تاريخ ترحيل SAP ناقص يومًا، وليس تاريخ فاتورة مؤكّدًا يدويًا.</p>}
        <div className="stats">
          <div className="stat"><span>فواتير اليوم</span><strong>{dailyInvoiceCount}</strong></div>
          <div className="stat"><span>كاش فان مسوّى</span><strong>{dailyCounts['cashvan-settled']}</strong></div>
          <div className="stat"><span>كاش فان يحتاج تسوية</span><strong>{dailyCounts['cashvan-pending']}</strong></div>
          <div className="stat"><span>مطابقة ماليًا</span><strong>{dailyCounts.match+dailyCounts.late}</strong></div>
          <div className="stat"><span>ترحيل SAP مثبت</span><strong>{dailySapCounts.posted}</strong></div>
          <div className="stat"><span>إثبات SAP غير مكتمل</span><strong>{dailySapCounts.waiting+dailySapCounts.missing+
            dailySapCounts.reversed+dailySapCounts.partial+dailySapCounts.review}</strong></div>
          <div className="stat"><span>بانتظار ترحيل</span><strong>{dailyCounts.pending}</strong></div>
          <div className="stat"><span>نقص أو زيادة مثبت</span><strong>{dailyCounts.short+dailyCounts.extra}</strong></div>
          <div className="stat"><span>تحتاج مراجعة بيانات</span><strong>{dailyCounts.review}</strong></div>
        </div>
        {dailyReport.rows.length>0&&dailyInvoiceCount>0&&dailyCounts.match+dailyCounts.late===dailyInvoiceCount&&dailySapCounts.posted===dailyInvoiceCount&&
          <p><span className="badge match"><CheckCircle2 size={14}/> جميع فواتير اليوم مطابقة ماليًا وترحيلاتها مثبتة في SAP حتى تاريخ الفحص.</span></p>}
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
            <th>ترحيلات SAP المرتبطة</th><th>تاريخ الترحيل</th><th>اعتماد الفاتورة</th><th>إثبات SAP حتى تاريخ الفحص</th><th>تفاصيل الأصناف والفرق</th>
          </tr></thead>
          <tbody>{dailyReport.rows.map((result,index)=><tr key={result.recordId+'|'+result.number+'|'+index}>
            <td dir="ltr"><strong>{result.cashVan?'كاش فان — بلا فاتورة زرقاء':result.number||'غير مثبت'}</strong></td>
            <td>{result.branch}</td><td dir="ltr">{result.invoiceDate}</td>
            <td dir="ltr">{result.transferNumbers.join('، ')||'غير مثبت'}</td>
            <td dir="ltr">{result.postedDates.join('، ')||'—'}</td>
            <td><span className={'badge '+(
              result.state==='match'||result.state==='late'||result.state==='cashvan-settled'?'match':
              result.state==='short'||result.state==='extra'?'difference':'review')}>
              {dailyStateNames[result.state]}
               {result.cashVan&&!!result.reverseNumbers?.length&&
                 <small style={{display:'block'}}>رقم الترحيل العكسي: <b dir="ltr">{result.reverseNumbers.join('، ')}</b></small>}
             </span></td>
            <td>{result.cashVan?'—':<span className={'badge '+(
               result.sapStatus==='posted'?'match':
               result.sapStatus==='partial'||result.sapStatus==='reversed'?'difference':'review')}>
               {sapDayNames[result.sapStatus||'missing']}
             </span>}</td>
             <td><details><summary>{result.cashVan?'عرض تسوية الكاش فان':result.items.length?'عرض الأصناف ('+result.items.length+')':'تفاصيل الفاتورة'}</summary>
              {!result.cashVan&&!result.items.length&&result.financiallyMatchedGroup&&
                <p className="hint">تفاصيل الأصناف غير محفوظة على مستوى هذه الفاتورة، وهذا لا يعني أن أصنافها صفر. اعتمادك المالي ما زال مطابقًا.</p>}
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
        <p className="hint">الشرطة (—) تعني أن الكمية التفصيلية غير مسجلة، ولا تعني صفرًا. الاعتماد المالي لا يتغيّر؛ «إثبات SAP» يخص وجود الحركات الصافية ضمن فترة الفحص، وليس مطابقة الكميات التفصيلية لصفحات قديمة لم تُحفظ.</p>
        <p className="hint">الفحص للقراءة فقط ويحترم اعتمادك المحفوظ، ولا يعدّل الفواتير أو أرشيف SAP. الفواتير غير المعتمدة تُفحص حسب الأصناف والكميات المتاحة. حركة SAP بتاريخ الترحيل، وليس بتاريخ الفاتورة.</p>
      </>}
    </section>
    </>}
    {(section==='opening')&&<>
    <section className="panel" aria-label="الأرصدة الافتتاحية المعتمدة">
      <div className="section-title"><div><h2>الأرصدة الافتتاحية المعتمدة — المستودع 011</h2>
        <p>الرصيد المسجل قبل أول حركة في تاريخ البداية. اعتماد رصيد صنف منفرد يخص ذلك الصنف فقط. لا يُفترض صفر لبقية الأصناف إلا عند توفر كشف افتتاحي كامل ومعتمد لنفس التاريخ.</p></div></div>
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
    </>}
    {(section==='query')&&<>
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
      <p className="sap-stock-query-instructions">انسخ الكويري إلى SAP، شغّله، صدّر النتيجة إلى Excel، ثم ارفعها في «ملفات SAP» تحت نوع الملف: رصيد 011 الفعلي في نهاية الفترة.</p>
      <p className="hint">هذا رصيد فعلي بنهاية اليوم المختار، ويشمل حركات ذلك اليوم. الرصيد الافتتاحي في 01/11 هو الرصيد قبل أول حركة في ذلك اليوم؛ لا ترفع نتيجة هذا الكويري كرصيد افتتاحي.</p>
    </section>
    </>}
    {(section==='query')&&<>
    <section className="panel no-print"><a className="button secondary" href="/reconciliation?view=sap-files">فتح ملفات SAP — الرفع والأرشيف والمعالجة</a>
      {error&&<p role="alert" className="banner error">{error}</p>}{message&&<p role="status" className="banner info">{message}</p>}
      {opening&&<p className="hint">كشف افتتاحي محفوظ: {opening.items.length} صنفًا · تاريخ الرصيد: {opening.date||'غير محدد'}</p>}
    </section>
    </>}
    {(section==='balance')&&<>
    <section className="panel" aria-label="مقارنة رصيد 011 الفعلي">
      <div className="section-title"><div><h2>رصيد 011 الفعلي — مقارنة الترحيلات والفواتير</h2>
        <p>اختر الفترة من أول الشهر حتى تاريخ الرصيد. تُقارن الترحيلات بالفواتير المشيّكة والمعتمدة، ويظهر رصيد SAP الفعلي لكل صنف بشكل مستقل.</p></div></div>
      {!closing?<p className="hint">ارفع كشف الرصيد الفعلي أو افتحه من «ملفات SAP» لعرض الأصناف ومقارنتها.</p>:<>
        <div className="stats">
          <div className="stat"><span>أصناف كشف الرصيد</span><strong>{closing.items.length}</strong></div>
          <div className="stat"><span>تاريخ الرصيد</span><strong>{closing.date||'غير محدد'}</strong></div>
          <div className="stat"><span>الترحيلات المحمّلة</span><strong>{transfers.length}</strong></div>
          <div className="stat"><span>أصناف مرتبطة بفواتير بانتظار اعتماد</span><strong>{coverageReady?uncoveredItems.length:'—'}</strong></div>
          <div className="stat"><span>أصناف تحتاج مراجعة البيانات</span><strong>{canCompare?incompleteItems.length:'—'}</strong></div>
          <div className="stat"><span>أصناف فيها فرق بالأرصدة</span><strong>{canCompare?stockRows.filter(item=>item.difference!==null&&Math.abs(item.difference)>0.000001).length:'—'}</strong></div>
        </div>
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
        {canCompare&&stockRows.some(item=>item.opening===null)&&<p className="banner warn" role="status">الافتتاحي غير مثبت لـ {stockRows.filter(item=>item.opening===null).length} صنفًا؛ تبقى ظاهرة لكن الفرق «—» وسببه غير مثبت حتى إرفاق كشف افتتاحي كامل. هذا لا يعني أن الفروقات السابقة صُفّرت أو سُوّيت.</p>}
        <p className="hint">«غير مغطى بفواتير معتمدة» = الوارد الذي يحتاج فاتورة − الوارد المغطى بفواتير مشيّكة ومعتمدة ومؤكد ورقها. لا تدخل حركات الكاش فان أو الإلغاء أو العكسي المسوّى بالكامل ضمن المطلوب له فواتير. هذه المقارنة لا تثبت أن الفاتورة رُحّلت على SAP.</p>
        <p className="hint">«المتوقع من الترحيلات» = الافتتاحي + الوارد − الصادر + أثر التصحيحات الموقّع. الصنف الغائب عن كشف افتتاحي كامل ومعتمد لنفس تاريخ البداية يُحسب افتتاحيه صفرًا؛ اعتماد صنف منفرد لا يثبت اكتمال الكشف. إذا كان كشف الافتتاحي غير متوفر أو فيه أخطاء أو تعارض تحويل وحدات، تبقى القيمة «—» ولا يُفترض الصفر. مطابقة رصيد المستودع النهائية تحتاج جميع حركات OINM، بما فيها البيع والتسويات.</p>
        <div className="table-controls no-print">
          <label>بحث في الأصناف<input type="search" value={stockQueryText} onChange={event=>setStockQueryText(event.target.value)} placeholder="كود SAP أو اسم الصنف"/></label>
          <label>عرض الأصناف<select value={stockFilter} disabled={!canCompare} onChange={event=>setStockFilter(event.target.value)}>
            <option value="all">كل الأصناف</option><option value="difference">فروقات الأرصدة فقط</option><option value="uncovered" disabled={!coverageReady}>بحاجة فواتير معتمدة</option>
            <option value="covered" disabled={!coverageReady}>مغطاة بفواتير معتمدة</option><option value="incomplete">بيانات تحتاج مراجعة</option>
          </select></label>
        </div>
        <div className="lieutenant-balance-list">
          {visibleStockRows.map(item=>{
            const evidence=stockEvidence.get(item.code)||[];
            const verified=evidence.filter(doc=>doc.counted);
            const reversed=evidence.filter(doc=>doc.kind==='ترحيل عكسي');
            const canceled=evidence.filter(doc=>doc.kind.includes('إلغاء')||doc.kind.includes('ملغى'));
            const gap=canCompare?item.difference:null;
            const positive=gap!==null&&gap>0.000001;
            const negative=gap!==null&&gap< -0.000001;
            const qty=(value:number|null)=>value===null?'—':value.toFixed(3);
            return <article className="lieutenant-balance-card" key={item.code+'|'+item.unit}>
              <div className="lieutenant-balance-header">
                <div>
                  <strong dir="ltr" className="lieutenant-balance-code">{item.code}</strong>
                  <div className="lieutenant-balance-name">{item.name}</div>
                </div>
                <span className="lieutenant-balance-unit">{stockUnit(item.unit)}</span>
              </div>
              <div className="lieutenant-balance-main">
                <div className="lieutenant-balance-metric">
                  <span>رصيد SAP الفعلي</span><strong dir="ltr">{qty(item.quantity)}</strong>
                </div>
                <div className="lieutenant-balance-metric">
                  <span>الرصيد المتوقع من الترحيلات</span>
                  <strong dir="ltr">{canCompare?qty(item.estimated):'—'}</strong>
                </div>
                <div className={'lieutenant-balance-metric lieutenant-balance-difference '+
                  (negative?'is-short':positive?'is-extra':'is-match')}>
                  <span>الفرق</span>
                  <strong dir="ltr">{gap===null?'—':(gap>0.000001?'+':'')+gap.toFixed(3)}</strong>
                  <small>{gap===null?'البيانات غير مكتملة':negative?'نقص برصيد SAP':
                    positive?'زيادة برصيد SAP':'مطابق'} · SAP − المتوقع</small>
                </div>
              </div>
              <div className="lieutenant-balance-secondary">
                <div><span>صافي الترحيلات</span><b dir="ltr">{canCompare&&item.movementComplete?qty(item.netTransfers):'—'}</b></div>
                <div><span>وارد يحتاج فاتورة</span><b dir="ltr">{canCompare&&item.movementComplete?qty(item.requiredIncoming):'—'}</b></div>
                <div><span>مرتبط بفواتير معتمدة</span><b dir="ltr">{coverageReady&&item.movementComplete?qty(item.approvedIncoming):'—'}</b></div>
                <div><span>غير مغطى بفواتير معتمدة</span><b dir="ltr">{coverageReady?qty(item.uncoveredIncoming):'—'}</b></div>
              </div>
              <div className="lieutenant-balance-notes">
                {gap!==null&&Math.abs(gap)>0.000001&&<p>
                  <strong>فحص سبب الفرق: </strong>
                  {reversed.length>0||canceled.length>0?
                    'ظهر '+reversed.length+' سطر عكسي و'+canceled.length+
                    ' سطر إلغاء/ملغى في كشف SAP. افتح تفاصيل المستندات للتأكد من أثرها.':
                    'لا يوجد عكسي أو إلغاء ظاهر لهذا الصنف في فترة كشف SAP الحالية؛ سبب الفرق غير مثبت.'}
                </p>}
                <strong>حالة الفواتير: </strong>
                {!coverageReady?'بانتظار اكتمال مصادر المقارنة':
                  !item.movementComplete?'بيانات ناقصة':
                  item.requiredIncoming===0?'لا يوجد وارد يحتاج فاتورة':
                  item.uncoveredIncoming===0?'مغطى بفواتير معتمدة':'بحاجة متابعة'}
                {item.converted&&<p>تم توحيد الوحدات حسب مرجع الأصناف.</p>}
                {item.issues.map(note=><p className="red" key={note}>{note}</p>)}
              </div>
              <details className="lieutenant-balance-evidence">
                <summary>كل المستندات المؤثرة: وارد وعكسي وإلغاء وتصحيح ({evidence.length})</summary>
                <p className="hint">{explainStockDifference(item,canCompare)}</p>
                <p className="hint">عكسي: {reversed.length} · إلغاء/ملغى: {canceled.length} · حركات محسوبة في الصافي: {verified.length}.
                  الوثائق أدناه تُظهر أثر كل حركة؛ لا يعني وجود عكسي أو إلغاء أنه سبب الفرق المتبقي، فقد يكون محسوبًا بالفعل.</p>
                {evidence.length>0?<div className="table-scroll"><table className="lieutenant-balance-evidence-table">
                  <thead><tr><th>رقم المستند</th><th>التاريخ</th><th>نوع الحركة</th><th>الاتجاه</th>
                    <th>كمية المستند</th><th>أثرها على صافي 011</th><th>المستند المقابل</th></tr></thead>
                  <tbody>{evidence.map((doc,i)=><tr key={doc.number+'|'+i}>
                    <td dir="ltr">{doc.number}</td><td dir="ltr">{doc.date}</td>
                    <td>{doc.kind}</td><td dir="ltr">{doc.direction}</td><td dir="ltr">{doc.quantity.toFixed(3)} {stockUnit(doc.unit)}</td>
                    <td dir="ltr">{!doc.counted?'أثر غير مثبت — بيانات ناقصة':
                      doc.unit===item.unit&&doc.effect!==null?
                        (doc.effect>0?'+':'')+doc.effect.toFixed(3):
                        'الوحدة مختلفة — راجع التحويل'}</td>
                    <td dir="ltr">{doc.counterpart||'—'}</td>
                  </tr>)}</tbody>
                </table></div>:
                  <p>لا تظهر حركات لهذا الصنف ضمن كشف SAP والفترة المحددة.</p>}
                {evidence.some(doc=>doc.note)&&<p className="hint">ملاحظات SAP: {Array.from(new Set(evidence.map(doc=>doc.note).filter(Boolean))).slice(0,4).join(' · ')}</p>}
              </details>
            </article>;
          })}
        </div>
        {!visibleStockRows.length&&<p className="hint">لا توجد أصناف بهذه الفلاتر.</p>}
        <details className="lieutenant-stock-details"><summary>تفاصيل الافتتاحي والوارد والعكسي والتصحيحات</summary>
          <p className="hint">الفرق التفسيري هو رصيد SAP − (الافتتاحي + صافي الترحيلات). لا يمثل حكمًا نهائيًا على صحة رصيد المستودع دون سجل جميع حركات المخزون.</p>
          <div className="table-scroll"><table><thead><tr>
            <th>كود SAP</th><th>الوحدة</th><th>الافتتاحي</th><th>الوارد</th><th>الصادر / العكسي</th>
            <th>أثر التصحيحات الموقّع</th><th>المتوقع من الترحيلات</th><th>رصيد SAP الفعلي</th><th>الفرق</th><th>تفسير الفرق</th>
          </tr></thead><tbody>{visibleStockRows.map(item=><tr key={item.code+'|'+item.unit}>
            <td dir="ltr">{item.code}</td><td>{stockUnit(item.unit)}</td>
            <td dir="ltr">{canCompare&&item.opening!==null?item.opening.toFixed(3):'—'}
              {canCompare&&item.openingAssumedZero&&<small style={{display:'block'}}>صفر حسب الافتتاحي المعتمد</small>}
            </td>
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
    </>}
    {(section==='transfers')&&<>
    <section className="panel">
      <div className="section-title"><div><h2>تدقيق الفترة المطلوبة</h2>
        <p>الفترة تحدد نتائج التقرير، ولا تحذف أو تخفي أي ترحيل من قاعدة البيانات.</p></div></div>
      <p className="hint">الفترة المختارة: <b dir="ltr">{from} — {to}</b> · غيّر الفترة من أعلى الشاشة.</p>
      <div className="table-controls">
        <label>البحث<input type="search" value={query} onChange={event=>{setQuery(event.target.value);setRowLimit(50)}} placeholder="رقم الترحيل أو الفرع"/></label>
        <button className="button primary" disabled={busy||autoLoading||!transfers.length||!periodValid}
          onClick={()=>void refreshSnapshot().catch(cause=>setError(cause.message))}><Search size={16}/> تحديث نتائج الفحص المحفوظة</button>
        <a className="button secondary" href="/reconciliation?view=sap-files">فتح أرشيف SAP ومتابعة الترحيلات المستقلة</a>
        <select aria-label="فلترة ترحيلات الملازم أول" value={filter} onChange={event=>{setFilter(event.target.value);setRowLimit(50)}}>
          <option value="pending">متابعة الملازم أول — الترحيلات غير المنسوبة والمراجعات</option>
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
        <div className="stat"><span>ترحيلات مستقلة بالأرشيف</span><strong>{selectedTransfer&&recordsReady&&periodValid?counts.queued:'—'}</strong></div>
        <div className="stat"><span>تحت متابعة الملازم</span><strong>{selectedTransfer&&recordsReady&&periodValid?counts.pending:'—'}</strong></div>
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
        <td>{row.source.cancellationState==='cancellation'?'إلغاء SAP':row.source.signedAdjustment?'تصحيح موقّع':row.source.reverse?'عكسي من 011':'وارد إلى 011'}</td>
        <td><span className={'badge '+(completeStatuses.has(row.status)?'match':row.status==='review'||row.status==='missing'?'difference':'review')}>
          {completeStatuses.has(row.status)?<CheckCircle2 size={13}/>:<AlertTriangle size={13}/>}
          {recordsReady?statusText[row.status]:'حالة الفاتورة غير متاحة'}
           {recordsReady&&row.status==='reversed'&&!!row.counterparts?.length&&
             <small style={{display:'block'}}>العكسي: <b dir="ltr">{row.counterparts.join('، ')}</b></small>}
           </span>
          {row.source.cancellationState==='canceled'&&<small style={{display:'block'}}>حالة SAP: ترحيل ملغى (Y)</small>}
          {row.source.cancellationState==='cancellation'&&<small style={{display:'block'}}>حالة SAP: مستند إلغاء (C)</small>}
          {row.source.cancellationState==='unknown'&&<small style={{display:'block'}}>حالة الإلغاء غير مذكورة</small>}
          {row.source.cancellationMentioned&&row.source.cancellationState==='unknown'&&<small style={{display:'block'}}>Remarks تذكر إلغاء دون إثبات</small>}</td>
        <td>{recordsReady?row.note:'تعذّر قراءة سجل المطابقات بالكامل؛ لا يمكن تحديد تغطية هذا الترحيل بعد.'}</td>
        <td>{row.recordId?<button type="button" className="button secondary small" onClick={()=>onOpenRecord(row.recordId!)}>{['approved','linked','paper'].includes(row.status)?'فتح الفاتورة':'فتح سجل الترحيل'}</button>:
          <span className="hint">للملازم أول — ترحيل فقط</span>}</td>
      </tr>)}</tbody></table></div>}
      {visible.length>rowLimit&&<button type="button" className="button secondary" onClick={()=>setRowLimit(value=>value+100)}>
        إظهار ترحيلات إضافية ({Math.min(rowLimit,visible.length)} من {visible.length})
      </button>}
      {selectedTransfer&&transfers.length>0&&!visible.length&&<p className="hint">لا توجد ترحيلات بهذه الفلاتر.</p>}
      {counts.review>0&&<p className="hint">هناك {counts.review} حركة تحتاج تدقيق العكسي أو الإلغاء أو بيانات المصدر. العكسي المطابق ليس إلغاء SAP؛ لا يُرسل كاش فان للجندي لمجرد عدم وجود فاتورة زرقاء.</p>}
    </section>
    </>}
    <MovementSummary transfers={transfers} from={from} to={to}/>
  </div>;
}
