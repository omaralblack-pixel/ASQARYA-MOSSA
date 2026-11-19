'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import SapImport from './SapImport';
import SapFiles from './SapFiles';
import {listSapFiles,readSapArchive,sapRequest} from '../lib/sap-files-client';
import type {SapJob} from '../lib/sap-processing';
import InstantMatch from './InstantMatch';
import {isAqabaBranch} from '../lib/aqaba-instant-reference';
import CatalogReplacement from './CatalogReplacement';
import {auditInstitutionReference} from '../lib/reference-audit';
import {parseSapImport,sapBranchFromRemarks,canUseSelectedBranchForSapMember,type SapImportGroup} from '../lib/sap-import';
import {readSavedSapImport} from '../lib/saved-sap-import';
import GroupLookup from './GroupLookup';
import InvoiceRegister,{InvoiceRegisterPrint} from './InvoiceRegister';
import SerialSoldier from './SerialSoldier';
import StockReport from './StockReport';
import FirstLieutenant from './FirstLieutenant';
import Colonel from './Colonel';
import Reassurance from './Reassurance';
import AqabaWorkspace from './AqabaWorkspace';
import ThemeToggle from '../../components/ThemeToggle';
import {ProjectSyncIndicator,useInstitutionSync,announceInstitutionChange} from '../../components/ProjectSyncIndicator';
import WorkspaceNav from '../../components/WorkspaceNav';
import './reconciliation.css';
import {fractionalQuantityNotes} from '../lib/fractional-quantity-notes';
import {ArrowLeftRight,Check,CheckCircle2,AlertTriangle,Plus,Trash2,ClipboardPaste,FileText,CalendarDays,History,Settings2,Search,Save,Printer,Upload,ChevronDown,ArrowUpRight,RefreshCw,Copy,PackageCheck} from 'lucide-react';
import {prepareReconciliation,readReconciliationRecord,withInvoiceDates,editInvoiceDate,addTransferToDraft,withSapInvoiceNumbers,invoiceDocumentNo,matchesInvoiceNumbers,sapReferences,checkSignature,parseTransfer,monthly,monthlyColumns,serialHeaders,isTransferNumber,transferNumbers,pageNumber,digits,numeric,fils,money,num,labels,type Draft,type Item,type Invoice,type SapAlias,type Transfer,type TransferSource, type BranchException, unmatchedBranchSources} from '../lib/reconcile';
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Amman'});
const uid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const newInvoice=():Invoice=>({id:uid(),number:'',date:'',amount:'',complete:false,quantities:{},attachments:[]});
const newTransfer=()=>({id:uid(),number:'',date:today(),paste:''});
type OrderedDraft = Draft & {pageEntryOrder?: string[]};
const blank=():OrderedDraft=>({mode:'manual',checks:{},branch:'',driver:'',date:today(),transfers:[newTransfer()],invoices:[newInvoice()],notes:''});
async function api(body?:any,url='',signal?:AbortSignal){
 const endpoint='/api/reconcile'+url;
 const options:RequestInit=body
   ?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}
   :{cache:'no-store',signal};
 // Retry read-only requests only: re-sending a failed POST could duplicate a saved invoice.
 const attempts=body?1:3;
 for(let attempt=0;attempt<attempts;attempt++){
   let response:Response;
   try{response=await fetch(endpoint,options)}
   catch{
     if(signal?.aborted)throw Error('انتهت مهلة استجابة الخادم. لا تُكرر الحفظ قبل التحقق من القرار المسجل.');
     if(attempt+1<attempts){await new Promise<void>(resolve=>setTimeout(resolve,350*(attempt+1)));continue}
     throw Error(body
       ?'انقطع الاتصال بالخادم. افحص السجل قبل إعادة الحفظ حتى لا تتكرر الفاتورة.'
       :'تعذّر الاتصال بخادم المطابقة. ملف SAP المحفوظ لم يُحذف؛ أعد محاولة تحديث القائمة.');
   }
   if(!body&&[502,503,504].includes(response.status)&&attempt+1<attempts){
     await new Promise<void>(resolve=>setTimeout(resolve,350*(attempt+1)));
     continue;
   }
   if(!(response.headers.get('content-type')||'').toLowerCase().includes('application/json')){
     if(response.redirected||response.status===401||response.status===403)
       throw Error('جلسة الدخول غير متاحة. سجّل الدخول مجددًا، ثم أعد تحميل السجل دون إعادة رفع ملف SAP.');
     throw Error('خادم المطابقة أعاد صفحة بدل بيانات JSON (HTTP '+response.status+'). ملف SAP المحفوظ لم يُحذف؛ تعذّر تحديث القائمة فقط.');
   }
   let data:any;
   try{data=await response.json()}
   catch{throw Error('خادم المطابقة أعاد JSON غير مكتمل (HTTP '+response.status+'). أعد محاولة تحديث القائمة.')}
   if(!response.ok)throw Error(data?.error||'تعذّر تنفيذ طلب المطابقة (HTTP '+response.status+').');
   if(body)announceInstitutionChange();
   return data;
 }
 throw Error('تعذّر الاتصال بخادم المطابقة.');
}
async function apiTimed(body?:any,url='',timeoutMs=15000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{return await api(body,url,controller.signal)}
 finally{clearTimeout(timer)}
}
type StoredTransfer = {transfer: Transfer; invoiceNumbers: string[]; recordId: string; version: number; branch: string};
class BranchExceptionRequired extends Error {
 constructor(readonly transferNo:string,readonly sourceBranches:string[],readonly targetBranch:string){
  super('الترحيل '+transferNo+' تابع لفرع '+sourceBranches.join('، ')+'، وليس فرع الكشف المفتوح '+targetBranch+'. لا يُسمح بالاستثناء إلا بتأكيدك وتسجيل السبب.');
 }
}
async function lookupSavedTransfer(number: string): Promise<StoredTransfer | null> {
  const response = await fetch('/api/reconcile?transfer=' + encodeURIComponent(number), {cache: 'no-store'});
  if (response.status === 404) return null;
  if (!response.ok) {
    const data = await response.json() as {error?: string};
    throw Error(data.error || 'تعذّر البحث عن الترحيل في السجل.');
  }
  return await response.json() as StoredTransfer;
}
function invoiceLinkMessage(number: string, invoices: string[]) {
  return 'الترحيل ' + number + ' مرتبط بفاتورة زرقاء (' + invoices.join('، ') + ').';
}
function Badge({state,label}:{state:string;label?:string}){return <span className={'badge '+state}>{state==='match'?<Check size={13}/>:<AlertTriangle size={13}/>} {label||labels[state]||state}</span>}
function TransferCard({transfer,index,onChange,onRemove,onLookup}:{transfer:any,index:number,onChange:(t:any)=>void,onRemove:()=>void,onLookup:(number:string)=>void}){const parsed=useMemo(()=>parseTransfer(transfer.paste,{allowReverse:true}),[transfer.paste]);return <section className="transfer-card"><div className="card-title"><span className="number">{index+1}</span><b>الترحيل {index+1}</b>{<button className="icon-button danger" aria-label={'حذف الترحيل '+(index+1)} onClick={onRemove}><Trash2 size={16}/></button>}</div><div className="two-fields"><label>رقم الترحيل<input value={transfer.number} onChange={e=>onChange({...transfer,number:e.target.value})} onBlur={e=>{if(e.target.value.trim()&&!transfer.paste.trim())onLookup(e.target.value.trim())}} placeholder="مثال: 2615835"/></label><label>تاريخ الترحيل<input type="date" value={transfer.date} onChange={e=>onChange({...transfer,date:e.target.value})}/></label></div><label className="paste-label">جدول SAP<textarea aria-label={'جدول SAP '+(index+1)} value={transfer.paste} onChange={e=>onChange({...transfer,paste:e.target.value})} placeholder={'الصق جدول الترحيل مع العناوين هنا…\nItem No.    Quantity    UoM Name    From Warehouse    To Warehouse'} dir="ltr"/></label><div className="paste-summary">{transfer.paste?<><span><CheckCircle2 size={14}/>{parsed.lines.length} بند صالح</span>{parsed.lines.some(line=>line.from==='011')&&<span>ترحيل عكسي · يُخصم من الصافي</span>}{parsed.issues.length>0&&<span className="red">{parsed.issues.length} ملاحظات قراءة</span>}{parsed.excluded.length>0&&<span className="amber">{parsed.excluded.length} خارج مسارات المؤسسة</span>}</>:<span>نسخ من SAP ← لصق هنا. تُقرأ Quantity فقط.</span>}</div>{parsed.issues.length>0&&<details><summary>ملاحظات قراءة الترحيل</summary>{parsed.issues.map((p,i)=><p className="red" key={i}>{p}</p>)}</details>}{parsed.excluded.length>0&&<details><summary>بنود خارج نطاق المؤسسة</summary>{parsed.excluded.map((p,i)=><p key={i}>{p}</p>)}</details>}</section>}
export default function Home(){const [reference,REF]=useState<Item[]>([]),[branches,BR]=useState<string[]>([]),[drivers,DR]=useState<string[]>([]),[draft,D]=useState<OrderedDraft|null>(null),[tab,T]=useState('work'),[loading,L]=useState(true),[busy,B]=useState(false),[error,E]=useState(''),[notice,N]=useState(''),[records,REC]=useState<any[]>([]),[query,Q]=useState(''),[onlyDiff,DIFF]=useState(false),[sort,SORT]=useState('entry'),[pageFilter,PAGE]=useState('all'),[pick,PICK]=useState(''),[edit,EDIT]=useState<Item|null>(null),[linkSap,LINK]=useState(''),[importTexts,IT]=useState<Record<string,string>>({}),[month,M]=useState(today().slice(0,7)),[serial,SERIAL]=useState(''),[columns,COLS]=useState({number:-1,date:-1,branch:-1}),[filtered,FILTERED]=useState(false),[dateFormat,DF]=useState('dmy'),[monthTab,MT]=useState('missing'),[monthReady,MR]=useState(false);
const [monthlySource,setMonthlySource]=useState('');
const monthlyLoadedText=useRef('');
const monthlyEditorText=useRef('');
monthlyEditorText.current=serial;
const sync=useInstitutionSync();
const [remoteConflict,setRemoteConflict]=useState('');
const draftBaseline=useRef('');
const [editOriginal,setEditOriginal]=useState<Item|null>(null);
const focusOpenedTransfers=useRef(false);
const [editAlias,setEditAlias]=useState('');
const [linkQuery,setLinkQuery]=useState('');
const [editorAqabaReference,setEditorAqabaReference]=useState<Item[]>([]);
const [aqabaPriceInput,setAqabaPriceInput]=useState('');
const [aqabaPriceDirty,setAqabaPriceDirty]=useState(false);
const [sapPreview,setSapPreview]=useState<{groups:SapImportGroup[];records:{id:string;payload:string}[]}>({groups:[],records:[]});
const [correctTransferInvoice,setCorrectTransferInvoice]=useState(false);
const [branchMismatch,setBranchMismatch]=useState<BranchExceptionRequired|null>(null);
const [branchExceptionReason,setBranchExceptionReason]=useState('');
 const [branchExceptionSaving,setBranchExceptionSaving]=useState(false);
const [transferConflict,setTransferConflict]=useState<{id:string;number:string}|null>(null);
const [missingTransfer,setMissingTransfer]=useState<{id:string;number:string}|null>(null);
const [duplicateTransfer,setDuplicateTransfer]=useState('');
const [transferSources, setTransferSources] = useState<Record<string, TransferSource>>({});
const [aqabaWorkReference,setAqabaWorkReference]=useState<Item[]|null>(null);
const [aqabaWorkLoading,setAqabaWorkLoading]=useState(false);
const [aqabaWorkError,setAqabaWorkError]=useState('');
const [searchTransferOpen,setSearchTransferOpen]=useState(false),[searchTransferNumber,setSearchTransferNumber]=useState(''),[searchTransferError,setSearchTransferError]=useState(''),[searchTransferMissing,setSearchTransferMissing]=useState(false),[searchTransferBusy,setSearchTransferBusy]=useState(false);
const sapTransfers=useMemo(()=>new Map(sapPreview.groups.filter(group=>!group.reversal)
  .flatMap(group=>group.members.filter(member=>!member.issues.length)
    .map(member=>[member.transfer.number,member] as const))),[sapPreview.groups]);
const savedTransfers=useMemo(()=>new Map(sapPreview.records.flatMap(record=>{
  const stored=readReconciliationRecord(record.payload);
  if(!stored)return [];
  return stored.transfers.flatMap(transfer=>transferNumbers(transfer.number).map(number=>[number,record.id] as const));
})),[sapPreview.records]);
useEffect(()=>{const first=blank();D(first);draftBaseline.current=JSON.stringify(first);const view=new URLSearchParams(window.location.search).get('view');if(['history','invoices','monthly','reference','instant','replace','stock','serial-soldier','lieutenant','lieutenant-day','lieutenant-balance','lieutenant-opening','lieutenant-query','lieutenant-cashvan','lieutenant-cancellations','aqaba','aqaba-prices','aqaba-stock','aqaba-documents','aqaba-queries','reassurance','sap-files','colonel'].includes(view||'')){T(view!);if(view==='history'||view==='invoices'||view==='monthly')getRecords().catch(e=>E(e.message));}api().then(x=>{REF(x.reference);BR(x.branches);DR(x.drivers)}).catch(e=>E(e.message)).finally(()=>L(false))},[]);

const aqabaWork=!!draft&&isAqabaBranch(draft.branch);
useEffect(()=>{
 if(!aqabaWork||tab!=='work'){
  setAqabaWorkReference(null);setAqabaWorkLoading(false);setAqabaWorkError('');
  return;
 }
 let active=true;setAqabaWorkReference(null);setAqabaWorkLoading(true);setAqabaWorkError('');
 api(undefined,'?aqabaPricing=1')
  .then(data=>{if(active){
   if(!Array.isArray(data.reference)||!data.reference.length)throw Error('مرجع أسعار العقبة غير متاح.');
   setAqabaWorkReference(data.reference as Item[]);
  }})
  .catch(error=>{if(active)setAqabaWorkError(error instanceof Error?error.message:'تعذّر تحميل مرجع العقبة.')})
  .finally(()=>{if(active)setAqabaWorkLoading(false)});
 return ()=>{active=false};
},[aqabaWork,tab,reference]);
const prepared=useMemo(()=>{
 if(!draft)return null;
 if(aqabaWork){
  // Do not use a stored Amman snapshot or add Amman-only codes on this branch.
  const current={...draft,referenceSnapshot:undefined,useCurrentReference:true};
  return prepareReconciliation(current,aqabaWorkReference||[]);
 }
 return prepareReconciliation(draft,reference);
},[draft,reference,aqabaWork,aqabaWorkReference]);
const baseResult=prepared?.result??null;
const result=baseResult;
useEffect(()=>{
 if(!aqabaWork&&prepared&&prepared.draft!==draft)
  D(current=>current===draft?prepared.draft:current);
},[draft,prepared,aqabaWork]);
useEffect(()=>{
 if(tab!=='work'||!focusOpenedTransfers.current)return;
 focusOpenedTransfers.current=false;
 const heading=document.getElementById('reconciliation-transfers-heading');
 heading?.focus({preventScroll:true});
 heading?.scrollIntoView({block:'start'});
},[tab]);
const heads=serialHeaders(serial);
const numbersOnly=serial.trim()!==''&&serial.trim().split(/\r?\n/).filter(line=>line.trim()).every(isTransferNumber);
const selectedPage=pageFilter==='all'?null:Number(pageFilter);
const aliasTarget=linkSap&&edit?reference.find(item=>item.code===digits(edit.code).trim()&&item.sapCode!==linkSap):undefined;
const sapDefinition=edit?.sapAliases?.find(alias=>alias.sapCode===editAlias)??edit;
const aqabaEditor=tab==='aqaba'||tab==='work'&&aqabaWork;
const editorSapCode=sapDefinition?.sapCode||'';
const originalAqabaPrice=editorAqabaReference.find(item=>item.sapCode===editorSapCode)?.price??null;
useEffect(()=>{setAqabaPriceInput(originalAqabaPrice===null?'':(originalAqabaPrice/1000).toFixed(3));setAqabaPriceDirty(false)},[editorSapCode,originalAqabaPrice]);
const singleBlueInvoice=!!draft&&draft.invoices.length===1&&!!invoiceDocumentNo(draft.invoices[0].number);
const getPage=(key:string)=>pageNumber(prepared?.draft.pages?.[key]); // A personal check-sheet mark, never invoice ownership.
const entryPositions=new Map(draft?.pageEntryOrder?.map((key,index)=>[key,index]));
const referenceAudit=useMemo(()=>auditInstitutionReference(reference),[reference]);
 const sortedRows=[...(result?.rows||[])].sort((a,b)=>{
  if(sort==='entry'&&entryPositions.size){
    const aPage=getPage(a.key),bPage=getPage(b.key);
    if(aPage!==bPage)return (aPage||Infinity)-(bPage||Infinity);
    if(aPage){
      const aPosition=entryPositions.get(a.key)??Infinity,bPosition=entryPositions.get(b.key)??Infinity;
      if(aPosition!==bPosition)return aPosition-bPosition;
    }
  }
  return (a.code||a.sapCode).localeCompare(b.code||b.sapCode,'en',{numeric:true})*(sort==='desc'?-1:1);
});
const historyRecords=tab==='history'?records.filter(r=>(r.branch+' '+r.driver+' '+r.payload).includes(query)):[];
const pageRows=sortedRows.filter(row=>selectedPage===null||getPage(row.key)===selectedPage);
const itemQuery=digits(query.trim()).toLowerCase();
const searchByItemSuffix=/^\d{4}$/.test(itemQuery);
const visibleRows=pageRows.filter(row=>searchByItemSuffix
  ?digits(row.code).endsWith(itemQuery)
  :digits(row.name+' '+row.code+' '+row.sapCode).toLowerCase().includes(itemQuery));
const expected=result?.expected??null;
const paperAmount=result?.total??null;
const difference=paperAmount===null||expected===null?null:paperAmount-expected;
const acceptedDifference=!!result&&'acceptedDifference' in result&&result.acceptedDifference===true;
const fractionalNotes=fractionalQuantityNotes(result?.rows||[]);
const suspectedFractionalNotes=fractionalNotes.filter(row=>row.suspectedSapRounding);
const fractionalPositiveFils=suspectedFractionalNotes.reduce((sum,row)=>sum+Math.max(0,row.amountDifferenceFils??0),0);
const fractionalNegativeFils=suspectedFractionalNotes.reduce((sum,row)=>sum+Math.min(0,row.amountDifferenceFils??0),0);
const comparisonStatus=difference===null?'review':difference!==0&&!acceptedDifference?'difference':'match';
const comparisonLabel='مقارنة قيمة إجمالي المجموعة (رقم الصفحة للتشييك فقط)';
const pageOptions=[...new Set([0,...sortedRows.map(row=>getPage(row.key))])].sort((a,b)=>a-b);const monthResult=useMemo(()=>monthly(serial,month,columns,filtered,dateFormat,records,branches),[serial,month,columns,filtered,dateFormat,records,branches]);
useEffect(()=>{
 if(tab!=='monthly')return;
 let active=true;
 void (async()=>{
  const results=await Promise.allSettled([listSapFiles(),sapRequest<{jobs:SapJob[]}>('/api/sap-processing')]);
  const candidates=results[0].status==='fulfilled'?results[0].value:[];
  const jobs=results[1].status==='fulfilled'?results[1].value.jobs:[];
  const monthlyKeys=new Set(jobs.filter(x=>x.kind==='monthly').map(x=>x.key));
  const file=candidates.find(x=>monthlyKeys.has(x.key));
  const shared=file?{name:file.name,text:await readSapArchive(file)}:await readSavedSapImport();
  if(!active)return;
  if(shared){
    if(monthlyEditorText.current.trim()&&monthlyEditorText.current!==monthlyLoadedText.current){
      E('وصل تحديث SAP جديد، لكن لديك كشف شهري معدل ولم يُحفظ. احتفظنا به؛ راجع المصدر قبل استبداله.');
      return;
    }
    monthlyLoadedText.current=shared.text;
    setSerial(shared.text);setMonthlySource(shared.name);await getRecords();if(active)MR(true);
  }else E('لا يوجد كشف SAP محفوظ. ارفعه من شاشة ملفات SAP مرة واحدة.');
 })().catch(e=>{if(active)E(e.message)});
 return()=>{active=false};
},[tab,sync.signal.version]);
async function run(fn:()=>Promise<void>){B(true);E('');N('');try{await fn()}catch(e:any){E(e.message)}finally{B(false)}}
function change(p:Partial<OrderedDraft>){
  D(d=>{
    if(!d)return d;
    const next={...d,...p,...(p.branch!==undefined&&p.branch!==d.branch?{checks:{}}:{})};
    return p.transfers||p.invoices?withInvoiceDates(next):next;
  });
}
function invoiceChange(index:number,p:Partial<Invoice>){if(!draft)return;change({invoices:draft.invoices.map((v,i)=>i===index?{...v,...p}:v)})}
function editTransfer(index:number,transfer:Transfer,lookup=false){
  if(!draft)return;
  const normalized=digits(transfer.number).trim();
  const existing=draft.transfers[index];
  const imported=sapTransfers.get(normalized);
  const owner=savedTransfers.get(normalized);
  const duplicate=draft.transfers.some((row,i)=>i!==index&&transferNumbers(row.number).includes(normalized));
  const numberChanged=existing.number!==transfer.number;
  if(numberChanged){
    const oldImported=sapTransfers.get(digits(existing.number).trim());
    const source = transferSources[existing.id];
    const removedSource = source && !transferNumbers(transfer.number).includes(source.number);
    if ((oldImported && oldImported.transfer.paste === transfer.paste) || removedSource) {
      transfer = {...transfer, paste: ''};
    }
    if (removedSource) setTransferSources(current => {
      const next = {...current};
      delete next[existing.id];
      return next;
    });
    setTransferConflict(null);
    E('');
    N('');
  }
  const valid=index===0&&(numberChanged||lookup)&&imported&&!transfer.paste.trim()&&!duplicate&&(!owner||owner===draft.id)
    &&(!draft.branch||!imported.branch||draft.branch===imported.branch);
  const updated=valid?{...transfer,number:normalized,date:imported.transfer.date,paste:imported.transfer.paste}:transfer;
  const next={...draft,transfers:draft.transfers.map((row,i)=>i===index?updated:row),...(valid&&!draft.branch?{branch:imported.branch}:{})};
  change(valid?withSapInvoiceNumbers(next,imported.invoices,normalized):next);
  if(valid)N('تم تعبئة تاريخ وبنود الترحيل '+normalized+' من معاينة SAP.');
}
async function lookupTransfer(id:string,number:string){
  if(!draft)return;
  const normalized=digits(number).trim();
  if(!/^\d{4,20}$/.test(normalized))return;
  if(draft.transfers.some(row=>row.id!==id&&transferNumbers(row.number).includes(normalized))){
    setDuplicateTransfer(normalized);
    return;
  }
  if (draft.transfers[0]?.id !== id) {
    try {
      const saved = await lookupSavedTransfer(normalized);
      const candidate = await findTransferForAddition(normalized, saved, draft);
      if (!candidate) {
        setMissingTransfer({id, number: normalized});
        return;
      }
      D(current => {
        const row = current?.transfers.find(transfer => transfer.id === id);
        return current && row && digits(row.number).trim() === normalized && !row.paste.trim()
          ? withSapInvoiceNumbers(addTransferToDraft(current, candidate.transfer, candidate.branch, id),candidate.invoiceNumbers,normalized)
          : current;
      });
      if (candidate.source) {
        const source = candidate.source;
        setTransferSources(current => ({...current, [id]: source}));
      }
      if (!candidate.transfer.paste.trim()) N('الصق جدول أصناف الترحيل ' + normalized + ' قبل الحفظ.');
    } catch (error) {
      if(error instanceof BranchExceptionRequired){
        // Clear only the unsaved placeholder number so the picker can fill that exact card.
        D(current=>current?{...current,transfers:current.transfers.map(row=>row.id===id&&!row.paste.trim()?{...row,number:''}:row)}:current);
        setSearchTransferNumber(normalized);setSearchTransferError(error.message);
        setBranchMismatch(error);setSearchTransferOpen(true);
      }else E(error instanceof Error ? error.message : 'تعذّر استرجاع الترحيل.');
    }
    return;
  }
  const owner=savedTransfers.get(normalized);
  if(owner&&owner!==draft.id){
    setTransferConflict({id:owner,number:normalized});
    return;
  }
  const imported=sapTransfers.get(normalized);
  if(imported){
    if(draft.branch&&imported.branch&&draft.branch!==imported.branch){
      try{
        const response=await api(undefined,'?branchExceptions='+encodeURIComponent(normalized)) as {exceptions:BranchException[]};
        const missing=unmatchedBranchSources(response.exceptions,normalized,draft.branch,[imported.branch]);
        if(!missing.length){
          D(current=>current?withSapInvoiceNumbers({
            ...current,transfers:current.transfers.map(row=>row.id===id?{...row,number:normalized,date:imported.transfer.date,paste:imported.transfer.paste}:row),
            branchExceptions:[...(current.branchExceptions||[]).filter(row=>row.transferNo!==normalized),
              ...response.exceptions.filter(row=>row.transferNo===normalized&&row.sourceBranch===imported.branch&&row.targetBranch===current.branch)],
          },imported.invoices,normalized):current);
          N('تم تحميل الترحيل '+normalized+' باستثناء الفرع المحفوظ؛ راجع الكشف قبل الحفظ.');
        }else{
          const conflict=new BranchExceptionRequired(normalized,missing,draft.branch);
          D(current=>current?{...current,transfers:current.transfers.map(row=>row.id===id&&!row.paste.trim()?{...row,number:''}:row)}:current);
          setSearchTransferNumber(normalized);setSearchTransferError(conflict.message);
          setBranchMismatch(conflict);setSearchTransferOpen(true);
        }
      }catch(error){E(error instanceof Error?error.message:'تعذّر التحقق من استثناء الفرع.')}
    }else{
      const index=draft.transfers.findIndex(row=>row.id===id);
      if(index>=0)editTransfer(index,draft.transfers[index],true);
    }
    return;
  }
  const unreadable=sapPreview.groups.flatMap(group=>group.members).find(member=>digits(member.transfer.number).trim()===normalized);
  if(unreadable){
    if(unreadable.issues.length>0&&unreadable.issues.every(issue=>issue.startsWith('تعارض فرع SAP:'))){
      // Offer an audited per-transfer correction rather than treating a stale
      // SAP export as a cancellation or requiring a whole-file re-upload.
      D(current=>current?{...current,transfers:current.transfers.map(row=>
        row.id===id&&!row.paste.trim()?{...row,number:''}:row)}:current);
      setSearchTransferNumber(normalized);
      setSearchTransferError('تم العثور على الترحيل في كشف SAP، لكن الفرع المطبوع قديم. اختر الفرع الصحيح ثم اعتمد استثناء الفرع بسبب واضح. '+[...new Set(unreadable.issues)].join('، '));
      setBranchMismatch(null);setBranchExceptionReason('');setSearchTransferOpen(true);
      return;
    }
    if(canUseSelectedBranchForSapMember(unreadable,draft.branch)){
      D(current=>{
        const row=current?.transfers.find(transfer=>transfer.id===id);
        return current&&row&&digits(row.number).trim()===normalized&&!row.paste.trim()
          ?withSapInvoiceNumbers(addTransferToDraft(current,unreadable.transfer,current.branch,id),unreadable.invoices,normalized):current;
      });
      N('تمت تعبئة الترحيل '+normalized+' من SAP باستخدام فرع المؤسسة المحدد في الكشف؛ راجع الفرع قبل الحفظ.');
      return;
    }
    E('الترحيل '+normalized+' موجود في كشف SAP لكنه يحتاج مراجعة: '+(unreadable.issues.join('، ')||'راجع نوع الحركة.')+
      (unreadable.issues.length===1&&unreadable.issues[0]==='الفرع غير معروف'&&!draft.branch?' حدد فرع المؤسسة أولًا.':''));
    return;
  }
  try{
    const found = await lookupSavedTransfer(normalized);
    if (!found) {
      setMissingTransfer({id, number: normalized});
      return;
    }
    if(found.recordId!==draft.id){
      setTransferConflict({id:found.recordId,number:normalized});
      return;
    }
    const transfer=found.transfer;
    if(!transfer?.paste?.trim())throw Error('الترحيل محفوظ بدون جدول أصناف.');
    D(current=>{
      if(!current||!current.transfers.some(row=>row.id===id&&digits(row.number).trim()===normalized&&!row.paste.trim()))return current;
      return withInvoiceDates({...current,transfers:current.transfers.map(row=>row.id===id?{...row,paste:transfer.paste,date:transfer.date}:row)});
    });
    E('');
    N('تم استرجاع بنود الترحيل '+normalized+' من السجل.');
  }catch(error){
    E(error instanceof Error?error.message:'تعذّر استرجاع الترحيل');
  }
}
async function findTransferForAddition(number: string, saved: StoredTransfer | null, addingTo: Draft, correctInvoice=false) {
  const fromAnotherRecord = saved && saved.recordId !== addingTo.id;
  if (fromAnotherRecord && saved.invoiceNumbers.length && !correctInvoice) {
    throw Error(invoiceLinkMessage(number, saved.invoiceNumbers));
  }
  if (saved && transferNumbers(saved.transfer.number).length !== 1) {
    throw Error('بنود الترحيل ' + number + ' محفوظة مع أرقام أخرى في جدول واحد. يلزم فصل الجدول أولًا.');
  }
  const savedPaste = saved?.transfer.paste?.trim();
  let file;
  try {
    file = await readSavedSapImport();
  } catch (error) {
    if (!savedPaste) throw error;
  }
  const parsed = file && parseSapImport(file.text, branches);
  const member = parsed ? parsed.groups.flatMap(group => group.members).find(row => row.transfer.number === number) : undefined;
  if(member?.reversal&&!member.reverseMovement)throw Error('الترحيل '+number+' ملغى في SAP؛ لا يجوز تجاوز الإلغاء باستثناء الفرع.');
  // Keep both independent SAP branch signals. The archived original can say
  // 56 while Remarks already identify 77; selecting 77 must not erase 56.
  const branchConflictOnly=!!member?.issues.length&&member.issues.every(issue=>issue.startsWith('تعارض فرع SAP:'));
  const notesBranch=branchConflictOnly?sapBranchFromRemarks(member!.remarks,branches):'';
  const sourceBranches=[...new Set([saved?.branch,member?.branch,notesBranch].filter((branch):branch is string=>!!branch))];
  if(branchConflictOnly&&!addingTo.branch)
    throw Error('حدد الفرع الصحيح في بيانات المطابقة أولًا، ثم راجع استثناء فرع SAP للترحيل '+number+'.');
  let approved:BranchException[]=[];
  if(addingTo.branch&&sourceBranches.some(branch=>branch!==addingTo.branch)){
    const response=await api(undefined,'?branchExceptions='+encodeURIComponent(number)) as {exceptions:BranchException[]};
    approved=response.exceptions;
    const missing=unmatchedBranchSources(approved,number,addingTo.branch,sourceBranches);
    if(missing.length)throw new BranchExceptionRequired(number,missing,addingTo.branch);
  }
  const fallbackBranch=member?canUseSelectedBranchForSapMember(member,addingTo.branch):false;
  // Only the specific branch disagreement is reviewable this way. Dates,
  // warehouses, quantities, cancellation and other issues stay blocked.
  const reviewedBranchConflict=!!(branchConflictOnly&&addingTo.branch&&sourceBranches.length>=2&&
    unmatchedBranchSources(approved,number,addingTo.branch,sourceBranches).length===0);
  const addingSecond = addingTo.transfers.some(row => transferNumbers(row.number).some(existing => existing !== number));
  if (!correctInvoice && addingSecond && member?.invoices.length && (!saved || fromAnotherRecord) && !matchesInvoiceNumbers(addingTo.invoices, member.invoices)) {
    throw Error(invoiceLinkMessage(number, member.invoices) + ' أرقام الفواتير لا تطابق الكشف المفتوح.');
  }
  if (!savedPaste && parsed?.issues.length) throw Error('تعذرت قراءة كشف SAP: ' + parsed.issues[0]);
  if (!savedPaste && member && ((member.issues.length && !fallbackBranch && !reviewedBranchConflict) || (member.reversal && !member.reverseMovement))) {
    throw Error('الترحيل ' + number + ' موجود في الكشف ويحتاج مراجعة: ' + ([...new Set(member.issues)].join('، ') || 'راجع نوع الحركة.') +
      (member.issues.length===1&&member.issues[0]==='الفرع غير معروف'&&!addingTo.branch?' حدد فرع المؤسسة في بيانات المطابقة أولًا.':''));
  }
  const transfer = savedPaste ? saved!.transfer : member?.transfer || saved?.transfer;
  if (!transfer) return null;
  return {
    transfer: {...transfer, number},
    branch: reviewedBranchConflict?addingTo.branch:(saved?.branch || member?.branch || (fallbackBranch?addingTo.branch:'')),
    branchFromSelection: !savedPaste && fallbackBranch,
    branchExceptions:approved.filter(row=>row.targetBranch===addingTo.branch&&sourceBranches.includes(row.sourceBranch)),
    invoiceNumbers: !correctInvoice&&!savedPaste&&!member?.reverseMovement?member?.invoices||[]:[],
    source: fromAnotherRecord ? {number, recordId: saved.recordId, version: saved.version, ...(correctInvoice?{correctInvoice:true,expectedInvoices:saved.invoiceNumbers}:{})} : undefined,
  };
}
async function approveBranchMismatch(){
 if(!branchMismatch||searchTransferBusy)return;
 const {transferNo,targetBranch,sourceBranches}=branchMismatch;
 if(transferNo!==digits(searchTransferNumber).trim()||targetBranch!==draft?.branch){
   setSearchTransferError('تغير رقم الترحيل أو فرع الكشف. ابحث مجددًا قبل اعتماد الاستثناء.');
   setBranchMismatch(null);return;
 }
 const reason=branchExceptionReason.trim();
 if(reason.length<8||reason.length>500||/^\d+$/.test(digits(reason))){
   setSearchTransferError('اكتب سببًا واضحًا للاستثناء (8 إلى 500 حرف). رقم الترحيل وحده ليس سببًا، ويجب توضيح مستند أو نتيجة المراجعة.');
   return;
 }
 setSearchTransferError('');
 setSearchTransferBusy(true);
 setBranchExceptionSaving(true);
 const verified=(rows:BranchException[])=>
   unmatchedBranchSources(rows,transferNo,targetBranch,sourceBranches).length===0;
 const reviewOnly=!!draft?.transfers.some(row=>transferNumbers(row.number).includes(transferNo));
 const savedMessage='تم التأكد من حفظ استثناء الفرع للترحيل '+transferNo+
   (reviewOnly?' في سجل القرارات. اضغط «التحقق من تصحيح الفرع» ثم احفظ الكشف المفتوح.':
     ' في سجل القرارات. اضغط «بحث وإضافة» لإكمال الربط، ثم احفظ الكشف.');
 try{
   const response=await apiTimed({action:'approveBranchException',transferNo,targetBranch,sourceBranches,reason},'',16000) as {exceptions?:BranchException[]};
   if(!Array.isArray(response.exceptions)||!verified(response.exceptions))
     throw Error('لم يؤكد الخادم حفظ الاستثناء في سجل المراجعة.');
   setBranchMismatch(null);setBranchExceptionReason('');
   setSearchTransferError(savedMessage);
 }catch(error){
   // A POST can reach D1 even if the browser times out. Read back instead of
   // blindly repeating the write or claiming it failed.
   let confirmed=false;
   try{
     const result=await apiTimed(undefined,'?branchExceptions='+encodeURIComponent(transferNo),8000) as {exceptions?:BranchException[]};
     confirmed=Array.isArray(result.exceptions)&&verified(result.exceptions);
   }catch{/* The result is unknown, not proof of a failed write. */}
   if(confirmed){
     setBranchMismatch(null);setBranchExceptionReason('');
     setSearchTransferError(savedMessage);
   }else{
     setSearchTransferError((error instanceof Error?error.message:'تعذّر تأكيد حفظ استثناء الفرع.')+
       ' لم يتم التأكد من تسجيل القرار. لا تعيد الاعتماد قبل إعادة فحص الترحيل.');
   }
 }finally{
   setBranchExceptionSaving(false);
   setSearchTransferBusy(false);
 }
}
function stageTransfer(transfer: Transfer, branch: string, source?: TransferSource, replaceId?: string, invoiceNumbers:string[]=[],exceptions:BranchException[]=[]) {
  const cardId = replaceId || uid();
  D(current => {
    if(!current)return current;
    const next=withSapInvoiceNumbers(addTransferToDraft(current,{...transfer,id:cardId},branch,replaceId),invoiceNumbers,transfer.number);
    return {...next,branchExceptions:[...(current.branchExceptions||[]).filter(row=>row.transferNo!==transfer.number),...exceptions]};
  });
  if (source) setTransferSources(current => ({...current, [cardId]: source}));
}
async function reviewDraftTransferBranch(){
  if(!draft||searchTransferBusy)return;
  const number=digits(searchTransferNumber).trim();
  if(!draft.transfers.some(row=>transferNumbers(row.number).includes(number))){
    setSearchTransferError('الترحيل غير موجود داخل هذا الكشف؛ استخدم «بحث وإضافة» أولًا.');
    return;
  }
  setSearchTransferBusy(true);setSearchTransferError('');
  try{
    const saved=await lookupSavedTransfer(number);
    const candidate=await findTransferForAddition(number,saved,draft);
    if(!candidate)throw Error('الترحيل غير متاح في كشف SAP المحفوظ.');
    if(candidate.branchExceptions.length){
      D(current=>current?{...current,branchExceptions:[
        ...(current.branchExceptions||[]).filter(row=>row.transferNo!==number),
        ...candidate.branchExceptions,
      ]}:current);
      setSearchTransferError('تم التحقق من تصحيح الفرع للترحيل '+number+' في سجل القرارات. احفظ الكشف المفتوح لتثبيت الفرع في بيانات المشروع؛ لا حاجة لرفع ملف SAP من جديد.');
    }else{
      setSearchTransferError('لا يوجد استثناء فرع مطلوب لهذا الترحيل. راجع الفرع المختار قبل الحفظ.');
    }
    setBranchMismatch(null);
  }catch(error){
    if(error instanceof BranchExceptionRequired)setBranchMismatch(error);
    else setBranchMismatch(null);
    setSearchTransferError(error instanceof Error?error.message:'تعذّر التحقق من تصحيح الفرع.');
  }finally{setSearchTransferBusy(false);}
}
async function addTransferFromSavedFile() {
  if (!draft || busy || searchTransferBusy) return;
  const number = digits(searchTransferNumber).trim();
  setSearchTransferError('');
  setSearchTransferMissing(false);
  if (!/^\d{4,20}$/.test(number)) {
    setSearchTransferError('أدخل رقم ترحيل صالح.');
    return;
  }
  if (draft.transfers.some(row => transferNumbers(row.number).includes(number))) {
    setSearchTransferError('الترحيل ' + number + ' موجود في هذا الكشف.');
    return;
  }
  const blankCard = draft.transfers.find(row => !row.number.trim() && !row.paste.trim());
  if (!blankCard && draft.transfers.length >= 30) {
    setSearchTransferError('وصلت إلى الحد الأقصى للترحيلات في الكشف.');
    return;
  }

  setSearchTransferBusy(true);
  try {
    const saved = await lookupSavedTransfer(number);
    if (saved && !draft.transfers.some(row => row.number.trim() || row.paste.trim())) {
      setSearchTransferOpen(false);
      setTransferConflict({id: saved.recordId, number});
      return;
    }
    const candidate = await findTransferForAddition(number, saved, draft, correctTransferInvoice);
    if (!candidate) {
      setSearchTransferMissing(true);
      return;
    }
    if(correctTransferInvoice && saved?.invoiceNumbers.length && !confirm('نقل الترحيل '+number+' من الفاتورة '+saved.invoiceNumbers.join('، ')+' إلى '+draft.invoices.map(i=>i.number).filter(Boolean).join('، ')+'؟ يتم تثبيت التصحيح عند حفظ الكشف مع حفظ نسخة من السجل السابق.'))return;
    stageTransfer(candidate.transfer, candidate.branch, candidate.source, blankCard?.id, candidate.invoiceNumbers,candidate.branchExceptions);
    setCorrectTransferInvoice(false);
    setSearchTransferOpen(false);
    setBranchMismatch(null);setBranchExceptionReason('');
    N(candidate.branchFromSelection
      ? 'تمت إضافة الترحيل '+number+' وأصنافه. فرع SAP غير معروف؛ استُخدم فرع المؤسسة الذي اخترته في الكشف. راجعه قبل الحفظ.'
      : candidate.transfer.paste.trim()
        ? 'تمت إضافة الترحيل ' + number + ' وأصنافه إلى الكشف. اضغط «حفظ» لتثبيت الإضافة.'
        : 'تمت إضافة رقم الترحيل ' + number + '. الصق جدول أصنافه قبل الحفظ.');
  } catch (error) {
    if(error instanceof BranchExceptionRequired)setBranchMismatch(error);
    else setBranchMismatch(null);
    setSearchTransferError(error instanceof Error ? error.message : 'تعذّر البحث عن الترحيل.');
  } finally {
    setSearchTransferBusy(false);
  }
}
async function exportFullHistory(){
 await run(async()=>{
  const data=await api(undefined,'?export=1');
  const [{historyExportRows},{invoiceWorkbook}]=await Promise.all([import('../lib/history-export'),import('../lib/invoice-workbook')]);
  const rows=historyExportRows(data.records);
  const url=URL.createObjectURL(invoiceWorkbook(rows)),link=document.createElement('a');
  link.href=url;link.download='institution-reconciliation-history.xlsx';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
}
async function getRecords(){
 const x=await api(undefined,'?records=1');
 if(!Array.isArray(x.records))throw Error('استجابة سجل المطابقات غير صالحة.');
 const readable=x.records.filter((record:{payload:string})=>readReconciliationRecord(record.payload));
 REC(readable);
 if(readable.length!==x.records.length)E('يوجد '+(x.records.length-readable.length)+' سجل غير مقروء. بقية السجلات متاحة؛ البيانات الأصلية لم تُحذف أو تُعدّل.');
}
// Cross-screen updates never replace the currently edited draft. A remote
// version change is surfaced for operator comparison; server save rejects stale
// versions with 409 even if a polling cycle was missed.
useEffect(()=>{
 if(!sync.signal.version)return;
 const scope=sync.signal.scope;
 if(scope==='reconcile'||scope==='all'){
   if(tab==='history'||tab==='invoices'||tab==='monthly')
     void getRecords().catch(cause=>E(cause instanceof Error?cause.message:'تعذّر تحديث السجل.'));
   if(tab!=='work')void api().then(data=>{REF(data.reference);BR(data.branches);DR(data.drivers)})
     .catch(cause=>E(cause instanceof Error?cause.message:'تعذّر تحديث مرجع المؤسسة.'));
   if(draft?.id&&!busy){
     const checkedId=draft.id,knownVersion=draft.version;
     void api(undefined,'?id='+encodeURIComponent(checkedId)).then(data=>{
       if(data.record?.version!==knownVersion)
         setRemoteConflict('تم تعديل نفس الكشف من شاشة أو جهاز آخر. احتفظنا بمسودتك؛ افتح النسخة الجديدة بعد مراجعة تغييراتك، ولا تحفظ فوقها.');
     }).catch(()=>setRemoteConflict('تعذّر التحقق من نسخة الكشف المفتوح. احتفظنا بمسودتك؛ أعد المحاولة قبل الحفظ.'));
   }
 }
},[sync.signal.version]);

function replaceWorkingDraft(next:OrderedDraft){
 if(draftBaseline.current&&draft&&JSON.stringify(draft)!==draftBaseline.current&&
   !window.confirm('هناك تعديلات غير محفوظة في كشفك. هل تريد تجاهلها وفتح كشف آخر؟'))return false;
 draftBaseline.current=JSON.stringify(next);
 setRemoteConflict('');D(next);
 return true;
}
async function openRecord(id:string,invoiceId?:string){
  if(draftBaseline.current&&draft&&JSON.stringify(draft)!==draftBaseline.current&&
    !window.confirm('لديك تعديلات غير محفوظة في الكشف المفتوح. هل تريد تجاهل المسودة وفتح كشف آخر؟'))return;
  const [data,settings]=await Promise.all([api(undefined,'?id='+encodeURIComponent(id)),api()]);
  const saved=readReconciliationRecord(data.record.payload);
  if(!saved)throw Error('بيانات هذا الكشف غير مقروءة؛ لم يتم تعديلها.');
  let page='all';
  if(invoiceId!==undefined){
    const index=saved.invoices?.findIndex(invoice=>invoice.id===invoiceId)??-1;
    if(index<0)throw Error('الفاتورة لم تعد موجودة في هذا الكشف. أعد جمع الفواتير.');
    if(!Array.isArray(saved.transfers)||!saved.transfers.length)
      throw Error('لا توجد ترحيلات محفوظة في كشف هذه الفاتورة.');
    page=String(index+1);
  }
  const next=withInvoiceDates({...saved,mode:'manual',checks:saved.checks||{},id:data.record.id,version:data.record.version,useCurrentReference:false});
  REF(settings.reference);
    setTransferSources({});
  focusOpenedTransfers.current=invoiceId!==undefined;
  draftBaseline.current=JSON.stringify(next);
  setRemoteConflict('');D(next);PAGE(page);Q('');T('work');
}
async function loadRecord(r:{id:string}){await run(()=>openRecord(r.id))}
function showDefinition(item:Item,sapCode?:string){
  LINK('');
  setEditOriginal(item);
  setEditAlias(item.sapAliases?.some(alias=>alias.sapCode===sapCode)?sapCode!:'');
  EDIT(item);
}
async function loadEditorReference(){
 const [data,pricing]=await Promise.all([api(),api(undefined,'?aqabaPricing=1')]);
 REF(data.reference);setEditorAqabaReference(pricing.reference);
 return data.reference as Item[];
}
async function openDefinition(code:string,sapCode?:string){
  await run(async()=>{
    const latest=await loadEditorReference();
    const item=latest.find(entry=>entry.code===code);
    if(!item)throw Error('هذا الصنف محفوظ في الكشف القديم. عرّفه في مرجع الأصناف لتعديله.');
    showDefinition(item,sapCode);
  });
}
async function newDefinition(){
 await run(async()=>{
  await loadEditorReference();LINK('');setEditOriginal(null);setEditAlias('');
  EDIT({code:'',sapCode:'',name:'',price:null,invoicePack:null,cartonPieces:null,sapUnit:'Piece',warehouseUnit:null,kgPerPiece:null,active:true});
 });
}
async function openLink(row:NonNullable<typeof result>['rows'][number]){
 return openSapLink(row.sapCode,row.name,row.details[0]?.unit||'Piece');
}
async function openSapLink(sapCode:string,name:string,unit='Piece'){
 await run(async()=>{
  const latest=await loadEditorReference();
  const existing=sapReferences(latest).find(item=>item.sapCode===sapCode);
  if(existing){
   const owner=latest.find(item=>item.code===existing.code)!;
   showDefinition(owner,sapCode);
   if(!existing.active)EDIT({...owner,active:true});
   return;
  }
  setLinkQuery('');LINK(sapCode);setEditOriginal(null);setEditAlias('');
  EDIT({code:'',sapCode,name:name.trim(),price:null,invoicePack:null,cartonPieces:null,sapUnit:unit,warehouseUnit:null,kgPerPiece:null,active:true});
 });
}
function updateSapDefinition(fields:Partial<SapAlias>){
  EDIT(item=>!item?item:editAlias
    ?{...item,sapAliases:item.sapAliases?.map(alias=>alias.sapCode===editAlias?{...alias,...fields}:alias)}
    :{...item,...fields});
}
function closeEdit(){EDIT(null);LINK('');setEditOriginal(null);setEditAlias('');E('')}
async function saveItem(priceOnly=false){
  if(!edit)return;
  await run(async()=>{
    const item=priceOnly&&editOriginal?editOriginal:{...edit,code:digits(edit.code).trim(),sapCode:edit.sapCode.trim(),name:edit.name.trim()};
    const price=aqabaPriceInput.trim()===''?null:fils(aqabaPriceInput);
    if(aqabaPriceInput.trim()&&(price===null||price>100000000)||priceOnly&&price===null)
      throw Error('أدخل سعر العقبة للحبة بالدينار بدقة حتى ثلاثة منازل.');
    const savePrice=price!==null&&(priceOnly||aqabaPriceDirty);
    const priceFields=savePrice?{aqabaPrice:aqabaPriceInput,aqabaSapCode:editorSapCode,
      aqabaPricePrevious:sapReferences(reference).find(item=>item.sapCode===editorSapCode)?.aqabaPrices?.[editorSapCode]??null}:{};
    const response=await api(linkSap?{action:'linkReference',item,...priceFields}:{action:'saveReferenceItem',item,previous:editOriginal,...priceFields});
    REF(response.reference);
    if(tab==='work'){
      const sapCode=editAlias||item.sapCode;
      D(d=>d?{...d,linkedSapCodes:[...new Set([...(d.linkedSapCodes||[]),sapCode])]}:d);
    }
    closeEdit();
    N(savePrice?'تم حفظ سعر العقبة'+(linkSap?' وربط الصنف':'')+' وتحديث السعر المعتمد للمطابقة.':linkSap?'تم حفظ الربط في المرجع وتحديث الكشف.':'تم حفظ تعريف الصنف في المرجع.');
  });
}
function excludeItem(row:NonNullable<typeof result>['rows'][number]){
 if(!confirm('استبعاد '+row.name+' من مطابقة هذه المجموعة؟ تبقى حركة SAP الأصلية محفوظة، وعند تغيّر الترحيلات يعود الصنف للمراجعة.'))return;
 D(current=>{
  if(!current)return current;
  const checks={...current.checks};delete checks[row.key];
  return {...current,checks,excludedItems:{...current.excludedItems,[row.key]:checkSignature(row)}};
 });
}
function restoreItem(key:string){
 D(current=>{
  if(!current)return current;
  const excludedItems={...current.excludedItems};delete excludedItems[key];
  return {...current,excludedItems};
 });
}
function toggleQuantityCheck(key:string,signature:string){
  D(d=>{
    if(!d)return d;
    const checks={...d.checks};
    if(checks[key]?.state==='match'&&checks[key].signature===signature)delete checks[key];
    else checks[key]={state:'match',signature};
    return {...d,checks};
  });
}
function removeInvoice(index:number){
  if(!draft||!confirm('إزالة ربط الفاتورة من الكشف؟ يتم تثبيت التعديل عند الحفظ.'))return;
  if(draft.invoices.length===1){
    change({invoices:[newInvoice()],checks:{},acceptedDifference:undefined});return;
  }
  // Personal page marks stay unchanged when invoice cards are added or removed.
  change({invoices:draft.invoices.filter((_,i)=>i!==index)});
}
function assignPage(key:string,raw:string){
  const value=digits(raw).trim();
  const page=pageNumber(value);
  if((value&&!/^\\d{1,2}$/.test(value))||page>99)return;
  D(d=>{
    if(!d||d.invoices.length===1&&!!invoiceDocumentNo(d.invoices[0].number))return d;
    const order=d.pageEntryOrder||[];
    if(page===pageNumber(d.pages?.[key])&&(!page||order.includes(key)))return d;
    const pageEntryOrder=order.filter(entry=>entry!==key);
    if(page)pageEntryOrder.push(key);
    // Intentionally never create invoices, allocate rows, or update approvals.
    return {...d,pages:{...d.pages,[key]:page?String(page):''},pageEntryOrder};
  });
}
function exportText(){
 if(!result)return;
 const header=['رقم المادة','رقم الصفحة (تشييك شخصي)','أرقام فواتير المجموعة','اسم المادة','الكمية بالحبة','السعر','القيمة','كود SAP'];
 const invoices=draft?.invoices.map(i=>i.number).filter(Boolean).join(' + ')||'';
 const rows=[header,...visibleRows.map(r=>[r.code,String(getPage(r.key)||''),invoices,r.name,num(r.transfer),money(r.unitPrice),money(r.expected),r.sapCode])];
 const txt='\\ufeff'+rows.map(r=>r.join('\\t')).join('\\r\\n');
 const blob=new Blob([txt],{type:'text/tab-separated-values;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download='institution-personal-check-sheet'+(selectedPage===null?'':'-page-'+selectedPage)+'.tsv';a.click();URL.revokeObjectURL(url);
}
async function save() {
  if (!draft || busy) return;
  if(aqabaWork&&(!aqabaWorkReference||aqabaWorkLoading||aqabaWorkError)){
    E('لا يمكن حفظ العقبة قبل تحميل أسعار العقبة المعتمدة. '+(aqabaWorkError||'حدّث أسعار الفرع وحاول مرة أخرى.'));
    return;
  }
  await run(async () => {
    const ready=prepared?.draft??draft;
    // prepareReconciliation assigns check page 1 for every item with a single real blue invoice.
    const savedDraft=ready;
    const sources = draft.transfers.flatMap(row => {
      const source = transferSources[row.id];
      return source && transferNumbers(row.number).includes(source.number) ? [source] : [];
    });
    const saved = await api({action: 'save', draft: savedDraft, transferSources: sources});
    setTransferSources(current => Object.fromEntries(Object.entries(current).filter(([, source]) => !sources.includes(source))));
    D(current => {
      if(!current||current.transfers[0]?.id!==draft.transfers[0]?.id)return current;
      const next={...current,id:saved.id,version:saved.version,referenceSnapshot:saved.referenceSnapshot,
        useCurrentReference:false,linkedSapCodes:undefined};
      draftBaseline.current=JSON.stringify(next);
      setRemoteConflict('');
      return next;
    });
    N(draft.invoices.some(invoice => invoiceDocumentNo(invoice.number))
? 'تم حفظ الفاتورة وترحيلاتها.'
: 'تم حفظ الترحيل في السجل.');
    if(sapPreview.groups.length){
      try{
        const {records}=await api(undefined,'?records=1');
        setSapPreview(current=>({...current,records}));
      }catch{
        E('تم الحفظ، وتعذّر تحديث قائمة الترحيلات المتاحة. اضغط «معاينة الاستيراد» لتحديثها.');
      }
    }
  });
}
function setSerial(text:string){SERIAL(text);FILTERED(false);MR(false);COLS(monthlyColumns(text))}
if(!draft)return <div className="initial">جاري تجهيز مساحة المطابقة…</div>;
return <div className="recon-app"><header className="topbar"><a className="brand" href="/"><span className="brand-mark"><ArrowLeftRight size={22}/></span><span><b>إدارة المؤسسة</b><small>مركز الكيلاني للأغذية · مساحة عمل المؤسسة</small></span></a><div className="topbar-end"><span className="topbar-private"><span className="private-dot"/>مساحة عمل خاصة</span><ThemeToggle/><form method="post" action="/logout"><button type="submit" className="btn">تسجيل خروج</button></form></div></header><div className="app-shell"><aside className="sidebar"><WorkspaceNav area="reconciliation" tab={tab} onSelect={key=>{E('');Q('');T(key);if(key==='history'||key==='invoices'||key==='monthly')void run(getRecords)}}/><div className="sidebar-note"><PackageCheck size={28}/><b>من الترحيل إلى الفاتورة</b><p>كل الأصناف تُقارن بالحبة. الأكواد والشدّات من مراجعها المعتمدة.</p><span>001 / 002 <ArrowLeftRight size={12}/> 011</span></div><div className="sidebar-bottom">المؤسسة الاستهلاكية العسكرية</div></aside><main><ProjectSyncIndicator checkedAt={sync.checkedAt} error={sync.error} checking={sync.checking}
   onRefresh={()=>{void sync.refreshNow()}}/>
 {remoteConflict&&tab==='work'&&<div className="banner error" role="alert">
   <strong>{remoteConflict}</strong>
   {draft?.id&&<button type="button" className="button secondary small" onClick={()=>{void openRecord(draft.id!)}}>
     فتح النسخة الأحدث بعد التأكيد
   </button>}
 </div>}
 {error&&!edit&&<div className="banner error" role="alert"><span>{error}</span><button type="button" aria-label="إغلاق التنبيه" onClick={()=>E('')}>×</button></div>}{notice&&<div className="banner success" role="status"><span>{notice}</span><button type="button" aria-label="إغلاق الرسالة" onClick={()=>N('')}>×</button></div>}{loading?<section className="panel">جاري تحميل المرجع…</section>:<>
{(tab==='aqaba'||tab.startsWith('aqaba-'))&&<AqabaWorkspace syncVersion={sync.signal.version} syncScope={sync.signal.scope} section={tab==='aqaba'?'invoices':tab.slice('aqaba-'.length) as 'prices'|'stock'|'documents'|'queries'} catalog={reference} onEditPrice={(sapCode,name)=>void openSapLink(sapCode,name)}/>}
{tab==='instant'&&<InstantMatch syncVersion={sync.signal.version} reference={reference} branches={branches} onDetailed={(picked,sources)=>{if(!replaceWorkingDraft(withInvoiceDates(picked)))return;setTransferSources(sources);PAGE('all');Q('');E('');T('work')}}/>}
 {tab==='replace'&&<CatalogReplacement reference={reference} onSaved={items=>REF(items)}/>}
 {tab==='stock'&&<StockReport syncVersion={sync.signal.version} syncScope={sync.signal.scope}/>}
 {tab==='reassurance'&&<Reassurance syncVersion={sync.signal.version} syncScope={sync.signal.scope} branches={branches} onOpenRecord={id=>{void run(()=>openRecord(id));}}
   onNavigate={view=>{E('');Q('');T(view)}} onOpenTransfer={(transfer,branch)=>{const next=blank();if(!replaceWorkingDraft({...next,branch,transfers:[{...transfer,id:uid()}]}))return;setTransferSources({});PAGE('all');Q('');E('');N('تم فتح الترحيل '+transfer.number+' من شاشة طمني.');T('work');}}/>}
 {tab==='sap-files'&&<SapFiles syncVersion={sync.signal.version} syncScope={sync.signal.scope}/>}
 {tab==='colonel'&&<Colonel syncVersion={sync.signal.version} syncScope={sync.signal.scope} branches={branches}
    onOpenRecord={id=>{void run(()=>openRecord(id));}}
    onNavigate={view=>{E('');Q('');T(view)}}/>}
 {(tab==='lieutenant'||tab.startsWith('lieutenant-'))&&<FirstLieutenant syncVersion={sync.signal.version} syncScope={sync.signal.scope} section={tab==='lieutenant'?'transfers':tab.slice('lieutenant-'.length) as 'day'|'balance'|'opening'|'query'|'cashvan'|'cancellations'} branches={branches} reference={reference}
    onOpenRecord={id=>{void run(()=>openRecord(id));}}
    onOpenTransfer={(transfer,branch)=>{
      const next=blank();
      if(!replaceWorkingDraft({...next,branch,transfers:[{...transfer,id:uid()}]}))return;
      setTransferSources({});PAGE('all');Q('');E('');N('تم فتح الترحيل '+transfer.number+
        ' من الملازم أول. أدخل الفاتورة الزرقاء وشيّكها قبل الحفظ.');T('work');
    }}/>}

 
 {tab==='work'&&result&&<>{aqabaWork&&<div className="banner info" role="status">
 <b>84 — العقبة · المطابقة بأسعار العقبة فقط</b>
 <p>{aqabaWorkLoading?'جاري تحميل الأسعار المعتمدة…':
    aqabaWorkError?'تعذّر تحميل الأسعار: '+aqabaWorkError:
    aqabaWorkReference?'مرجع العقبة: '+aqabaWorkReference.filter(item=>item.price!==null).length+' سعر صنف. الأصناف دون سعر أو شدة مؤكدة لا تأخذ سعر عمّان.':
    'الحفظ معطّل لحين تحميل أسعار العقبة.'}</p>
 </div>}
 {draft?.branchExceptions?.some(row=>row.targetBranch===draft.branch&&draft.transfers.some(t=>transferNumbers(t.number).includes(row.transferNo)))&&
<div className="banner info"><b>استثناءات فرع معتمدة:</b> {draft.branchExceptions.filter(row=>row.targetBranch===draft.branch&&draft.transfers.some(t=>transferNumbers(t.number).includes(row.transferNo))).map(row=>row.transferNo+' ('+row.sourceBranch+' ← '+row.targetBranch+'؛ '+row.reason+')').join('، ')}. لم تتغير بيانات SAP الأصلية.</div>}
<div className="page-title"><div><p className="eyebrow">{draft.invoices.some(invoice=>invoiceDocumentNo(invoice.number))?'مطابقة الفاتورة الزرقاء':draft.id?'ترحيل محفوظ':'ترحيل جديد'}</p><h1>ألصق الترحيلات. ووزّع الأصناف على الفواتير الزرقاء.</h1><p>كشف بأكواد المؤسسة وتسمياتها وأسعارها، جاهز للمطابقة اليدوية.</p></div><button className="button secondary" onClick={()=>{if(draft.transfers.some(t=>t.paste.trim())&&!confirm('فتح ترحيل جديد؟ احفظ التعديلات الحالية أولًا إذا أردت الاحتفاظ بها.'))return;setTransferSources({});D(blank());PAGE('all');Q('');N('');E('')}}><Plus size={16}/>ترحيل جديد</button></div>{draft.id&&!draft.useCurrentReference&&<div className="banner info">تُستخدم الأسعار والشدّات المسجلة وقت الحفظ، وتُستكمل التعريفات الناقصة من المرجع المعتمد.<button className="text-button" onClick={()=>change({useCurrentReference:true})}>إعادة المطابقة بالمرجع الحالي</button></div>}<div className="stats"><div className={'stat status-stat '+result.status}><span>نتيجة المطابقة</span><strong><Badge state={result.status} label={acceptedDifference?'مطابق باعتمادك':undefined}/></strong><small>{result.differences} فروقات أصناف · {result.review} بحاجة مراجعة</small></div><div className="stat"><span>مجموع مبالغ الفواتير</span><strong>{money(result.total)} <small>د.أ</small></strong><small>{draft.invoices.length} فواتير مرتبطة</small></div><div className="stat"><span>{aqabaWork?'قيمة الترحيلات حسب أسعار العقبة':'قيمة الترحيلات حسب أسعار المؤسسة'}</span><strong>{money(result.expected)} <small>د.أ</small></strong><small>{draft.transfers.length} ترحيلات مرتبطة</small></div><div className={'stat '+(result.priceDifference?'warn':'')}><span>فرق القيمة</span><strong dir="ltr">{money(result.priceDifference)} <small>د.أ</small></strong><small>الفواتير − قيمة الترحيلات</small></div></div><SapImport records={sapPreview.records} onPreview={(groups,records)=>setSapPreview({groups,records})} branches={branches} readRecords={async()=>{const data=await api(undefined,'?records=1');return data.records}} saveDraft={async imported=>{const data=await api({action:'save',draft:imported});return data.id}} openSaved={id=>loadRecord({id})} onReviewBranch={number=>{
  if((draft.id||draft.transfers.some(transfer=>transfer.paste.trim()))&&!confirm('فتح مراجعة فرع الترحيل؟ احفظ التعديلات الحالية أولًا إذا أردت الاحتفاظ بها.'))return;
  setTransferSources({});D(blank());PAGE('all');Q('');E('');
  setSearchTransferNumber(number);
  setSearchTransferError('الترحيل موجود في كشف SAP القديم. اختر الفرع الصحيح، ثم سجّل استثناء الفرع مع سبب المراجعة؛ لن تُرفع ملفات SAP مرة ثانية.');
  setSearchTransferMissing(false);setBranchMismatch(null);setBranchExceptionReason('');setSearchTransferOpen(true);
}} openDraft={imported=>{
  if((draft.id||draft.transfers.some(transfer=>transfer.paste.trim()))&&!confirm('فتح كشف الاستيراد؟ احفظ التعديلات الحالية أولًا إذا أردت الاحتفاظ بها.'))return;
  setTransferSources({});D(imported);PAGE('all');Q('');E('');
  document.getElementById('reconciliation-group')?.scrollIntoView({block:'start'});
}}/><section id="reconciliation-group" className="panel"><div className="section-title"><span className="step">01</span><div><h2>بيانات المطابقة</h2><p>حدّد فرع الفاتورة الزرقاء.</p></div></div><div className="form-grid"><GroupLookup label="فرع المؤسسة" required placeholder="اكتب اسم الفرع أو رقمه" items={branches} value={draft.branch} onChange={branch=>change({branch})}/><GroupLookup label="الشوفير" placeholder="اكتب اسم الشوفير أو رقمه (اختياري)" items={drivers} value={draft.driver} onChange={driver=>change({driver})}/><label>تاريخ الكشف<input type="date" value={draft.date} onChange={e=>change({date:e.target.value})}/></label></div></section><section className="panel"><div className="section-title"><span className="step">02</span><div><h2 id="reconciliation-transfers-heading" tabIndex={-1}>ترحيلات SAP</h2><p>أضف الترحيل برقم SAP. تُخصم الكميات العكسية من الصافي.</p></div><button type="button" className="button secondary" aria-haspopup="dialog" disabled={busy} onClick={()=>{setSearchTransferNumber('');setSearchTransferError('');setSearchTransferMissing(false);setBranchMismatch(null);setBranchExceptionReason('');setSearchTransferOpen(true)}}><Plus size={16}/>إضافة ترحيل بالرقم / تصحيح فرعه</button></div>
<div className="cards-grid">{draft.transfers.map((t,i)=><TransferCard key={t.id} transfer={t} index={i} onChange={v=>editTransfer(i,v)} onRemove={()=>{if(!confirm('إزالة الترحيل من الكشف؟ لا يُحفظ التعديل إلا عند الضغط على حفظ.'))return;change({transfers:draft.transfers.length===1?[newTransfer()]:draft.transfers.filter((_,j)=>j!==i)})}} onLookup={number=>lookupTransfer(t.id,number)}/>)}</div></section><section className="panel invoice-entry"><div className="section-title"><span className="step">03</span><div><h2>الفواتير الورقية المرتبطة</h2><p>سجل الفواتير الزرقاء الحقيقية والمبالغ. أرقام صفحات التشييك الشخصية لا توزّع الأصناف أو الترحيلات بين الفواتير.</p></div><button className="button secondary" disabled={draft.invoices.length>=30} onClick={()=>change({invoices:[...draft.invoices,newInvoice()]})}><Plus size={16}/>إضافة فاتورة</button></div><div className="invoice-grid">{draft.invoices.map((inv,i)=><article className="invoice-card" key={inv.id}><div className="card-title"><FileText size={18}/><input className="invoice-title-input" aria-label={'عنوان الفاتورة الزرقاء '+(i+1)} title="اضغط لتعديل عنوان الفاتورة" maxLength={80} value={inv.title??'الفاتورة الزرقاء '+(i+1)} onChange={e=>invoiceChange(i,{title:e.target.value})} onBlur={()=>{const title=inv.title?.trim()||undefined;if(title!==inv.title)invoiceChange(i,{title})}}/><button type="button" className="text-button" onClick={()=>{PAGE('all');Q('');document.getElementById('invoice-sheet')?.scrollIntoView({block:'start'})}}>عرض كشف المجموعة</button>{<button className="icon-button danger" aria-label={'حذف الفاتورة '+(i+1)} onClick={()=>removeInvoice(i)}><Trash2 size={15}/></button>}</div><div className="invoice-fields"><label>رقم الفاتورة الورقية الحقيقي<input value={inv.number} onChange={e=>invoiceChange(i,{number:e.target.value,manualNumber:true})}/></label><label>مبلغ الفاتورة (د.أ)<input inputMode="decimal" value={inv.amount} onChange={e=>invoiceChange(i,{amount:e.target.value})} placeholder="0.000"/></label><div className="invoice-date-field"><label>{inv.manualDate?'تاريخ الفاتورة · تعديل يدوي':'تاريخ الفاتورة · قبل الترحيل بيوم'}<input type="date" value={inv.date} onChange={e=>change({invoices:editInvoiceDate(draft.invoices,inv.id,e.target.value)})}/></label>{inv.manualDate&&<button type="button" className="text-button" onClick={()=>invoiceChange(i,{date:'',manualDate:false})}>رجوع للتاريخ التلقائي</button>}</div></div><label className="check-label"><input type="checkbox" checked={inv.complete} onChange={e=>invoiceChange(i,{complete:e.target.checked})}/>الفاتورة الورقية موجودة لدي</label>


</article>)}</div></section>
<section id="invoice-sheet" className="panel results-panel blue-invoice"><div className="section-title no-print"><span className="step">04</span><div><h2>كشف المؤسسة للمطابقة اليدوية</h2><p>رقم الصفحة ملاحظة شخصية للتشييك فقط، لا يغيّر الفواتير أو المطابقة. اضغط الكمية لتعليمها كمُشيّكة أو لإلغاء العلامة.</p></div><button className="button secondary" onClick={exportText}><ArrowUpRight size={16}/>تصدير الكشف</button><button className="icon-button" aria-label="طباعة كشف المؤسسة" onClick={()=>window.print()}><Printer size={18}/></button></div>{result.problems.length>0&&<details className="review-list no-print"><summary>{result.problems.length} نقاط يلزم إكمالها قبل اعتماد المطابقة</summary>{result.problems.map((p,i)=><p key={i}>{p}</p>)}</details>}<div className="table-controls no-print"><div className="search"><Search size={16}/><input value={query} onChange={e=>Q(e.target.value)} aria-label="البحث في أصناف الفاتورة" placeholder="ابحث بآخر 4 أرقام من رقم المادة أو بالاسم…"/></div><select aria-label="ترتيب الأصناف" value={sort} onChange={e=>SORT(e.target.value)}><option value="entry">حسب ترتيب التشييك الشخصي</option><option value="asc">رقم المادة تصاعدي</option><option value="desc">رقم المادة تنازلي</option></select><select aria-label="فلتر رقم صفحة التشييك الشخصي" value={pageFilter} onChange={e=>PAGE(e.target.value)}><option value="all">كل أرقام التشييك</option>{pageOptions.map(page=><option key={page} value={page}>{page===0?'بلا رقم شخصي':'رقم تشييك '+page}</option>)}</select></div>
{selectedPage!==null&&<p className="hint no-print">فلتر التشييك الشخصي يعرض البنود فقط؛ مبلغ المجموعة ونتيجة المطابقة لا يتغيران باختيار رقم الصفحة.</p>}
{'excludedRows' in result&&(result.excludedRows as typeof result.rows).length>0&&<details className="no-print" open><summary>أصناف مستبعدة من المطابقة ({(result.excludedRows as typeof result.rows).length})</summary><p>الاستبعاد لهذه المجموعة فقط؛ حركة SAP الأصلية محفوظة. عند تغيّر بنود الترحيل يعود الصنف للمراجعة.</p>{(result.excludedRows as typeof result.rows).map(row=><p key={row.key}><b>{row.sapCode} · {row.name}</b> <button type="button" className="text-button" onClick={()=>restoreItem(row.key)}>إرجاع للمطابقة</button></p>)}</details>}
<div className="blue-paper"><div className="blue-heading"><h2>المؤسسة الاستهلاكية العسكرية</h2><h3>كشف مطابقة فواتير المجموعة{selectedPage!==null?' · رقم تشييك '+selectedPage:''}</h3><p>مُعدّ من ترحيلات SAP للمراجعة مقابل الفاتورة الأصلية</p></div><div className="blue-meta"><span>اسم السوق: <b>{draft.branch||'—'}</b></span><span>تاريخ الكشف: <b>{draft.date}</b></span><span>أرقام الترحيلات: <b>{draft.transfers.map(t=>t.number||'—').join('، ')}</b></span><span>أرقام فواتير المجموعة: <b>{draft.invoices.map(i=>i.number||'—').join('، ')}</b></span><span>اسم الشركة: <b>مركز الكيلاني للأغذية</b></span><span>السائق: <b>{draft.driver||'—'}</b></span></div>
<div className="table-scroll"><table className="blue-table"><thead><tr><th>ت</th><th>رقم المادة</th><th>رقم الصفحة (شخصي)</th><th>اسم المادة</th><th>صافي الكمية بالحبة</th><th>السعر</th><th>القيمة</th></tr></thead><tbody>{visibleRows.map((r,index)=>{
  const signature=r.transfer===null?'':checkSignature(r);
  const checked=draft.checks?.[r.key]?.state==='match'&&draft.checks[r.key].signature===signature;
  return <tr key={r.key} className={r.state}><td>{index+1}</td><td><code>{r.code||'غير مربوط'}</code><small className="sap-ref">{r.sapCode}</small></td><td><input key={getPage(r.key)} className="source-page-input no-print" type="text" readOnly={singleBlueInvoice} title={singleBlueInvoice?'رقم الصفحة 1 تلقائيًا عند وجود فاتورة زرقاء واحدة':undefined} inputMode="numeric" maxLength={2} aria-label={'رقم صفحة التشييك الشخصي للصنف '+(r.code||r.sapCode)} placeholder="0" defaultValue={getPage(r.key)||''} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}} onChange={e=>{e.currentTarget.dataset.edited='true'}} onBlur={e=>{
    const input=e.currentTarget;
    if(!input.dataset.edited)return;
    delete input.dataset.edited;
    const value=digits(input.value).trim();
    if((value&&!/^\d{1,2}$/.test(value))||pageNumber(value)>99){
      input.value=String(getPage(r.key)||'');
      return;
    }
    assignPage(r.key,value);
    input.value=String(pageNumber(value)||'');
  }}/><span className="print-check">{getPage(r.key)}</span></td><td className="name-cell"><b>{r.name}</b>{r.details.length>0&&<details className="no-print"><summary>تفاصيل SAP</summary>{r.details.map((l,j)=><p key={j}>ترحيل {l.transferNo} · {l.quantity} {l.unit} · {l.from} ← {l.to}</p>)}</details>}{r.errors.map((e,j)=><small className="red" key={j}>{e}</small>)}<button type="button" className="text-button no-print" onClick={()=>excludeItem(r)}>استبعاد من الفاتورة</button>{aqabaWork?<><button type="button" className="button secondary small no-print" disabled={busy} onClick={()=>openLink(r)}>{sapReferences(reference).some(item=>item.active&&item.sapCode===r.sapCode)?'تعديل ربط الصنف':'ربط الصنف'}</button><button type="button" className="text-button no-print" disabled={busy} onClick={()=>openLink(r)}>{r.unitPrice===null?'إضافة سعر العقبة':'تعديل سعر العقبة'}</button></>:r.item?<button className="text-button" disabled={busy} onClick={()=>openDefinition(r.code,r.sapCode)}>تعديل التعريف</button>:<button className="button secondary small no-print" disabled={busy} onClick={()=>openLink(r)}>ربط الصنف</button>}</td><td className="qty">{r.transfer===null?num(r.transfer):<><button type="button" className="qty-check no-print" aria-pressed={checked} aria-label={'تشييك كمية '+r.name+'، '+num(r.transfer)+' حبة'} onClick={()=>toggleQuantityCheck(r.key,signature)}>{num(r.transfer)}</button><span className="print-check">{num(r.transfer)}</span></>}</td><td><button type="button" className="text-button no-print" disabled={busy} aria-label={'تعديل سعر '+r.name} onClick={()=>aqabaWork||!r.item?openLink(r):openDefinition(r.code,r.sapCode)}>{money(r.unitPrice)} · تعديل السعر</button><span className="print-check">{money(r.unitPrice)}</span></td><td>{money(r.expected)}</td></tr>})}</tbody></table>{result.rows.length>0&&!visibleRows.length&&<div className="empty">لا توجد أصناف ضمن العرض الحالي.</div>}{!result.rows.length&&<div className="empty"><ClipboardPaste size={35}/><h3>ألصق أول ترحيل ليظهر كشف المؤسسة</h3><p>الكميات تُحسب بالحبة من وحدات وشدّات SAP.</p></div>}</div>
<div className="blue-total">
  <b>قيمة الترحيلات في المجموعة: {money(expected)} دينار</b>
  <span>مجموع مبالغ الفواتير الزرقاء: {money(paperAmount)} دينار</span>
  <strong>فرق القيمة للمجموعة كاملة: {money(difference)} دينار</strong>
  <div className="blue-comparison">
    <span>{comparisonLabel}</span>
    {difference!==null?<Badge state={comparisonStatus} label={difference===0?'القيمة الإجمالية متطابقة':acceptedDifference?'فرق قيمة معتمد':undefined}/>:<small>{expected===null?'قيمة الأصناف غير مكتملة':'أدخل مبالغ الفواتير لإظهار النتيجة'}</small>}
  </div>
</div></div><p className="hint">رقم الصفحة للتشييك الشخصي فقط؛ لا يعني أن الصنف أو الترحيل يخص فاتورة بعينها. الربط الرسمي يعتمد بيانات الفواتير والترحيلات المحفوظة.</p>{query&&<p className="amber filter-warning">البحث وفلتر أرقام التشييك يحددان البنود المعروضة والمطبوعة فقط. الإجمالي والفرق والمطابقة تُحسب على المجموعة كاملة.</p>}</section><section className="panel save-panel"><label>ملاحظات المجموعة<textarea value={draft.notes} maxLength={5000} onChange={e=>change({notes:e.target.value})} placeholder="أي ملاحظات على المستندات أو الفروقات…"/></label>
{fractionalNotes.length>0&&<div className="fractional-notes" role="region" aria-label="فروقات الكسور للمراجعة آخر الشهر">
  <h3>فروقات الكسور — متابعة آخر الشهر ({fractionalNotes.length} صنف)</h3>
  <p>هذه ملاحظات آلية من صافي الكمية بالحبة بعد التحويل من SAP. الفرق الموجب يعني أن قيمة SAP أعلى من قيمة أقرب عدد صحيح، والسالب يعني أقل. لا يتم تقريب الكمية أو تعديل السعر أو اعتماد المطابقة تلقائيًا.</p>
  <div className="fractional-totals">
    <span>زيادات مشتبه أنها تقريب: <b dir="ltr">+{money(fractionalPositiveFils)} د.أ</b></span>
    <span>نواقص مشتبه أنها تقريب: <b dir="ltr">{money(fractionalNegativeFils)} د.أ</b></span>
    <span>صافي أثر الكسور المحتملة: <b dir="ltr">{fractionalPositiveFils+fractionalNegativeFils>0?'+':''}{money(fractionalPositiveFils+fractionalNegativeFils)} د.أ</b></span>
  </div>
  <div className="table-scroll"><table className="fractional-table">
    <thead><tr><th>الصنف</th><th>الترحيل المرتبط بالكسر</th><th>الصافي من SAP</th><th>أقرب حبة كاملة (للمقارنة فقط)</th><th>فرق الحبات</th><th>أثر القيمة</th><th>التصنيف</th></tr></thead>
    <tbody>{fractionalNotes.map(row=><tr key={row.key}>
      <td><b>{row.code||row.sapCode}</b><small>{row.name}</small></td>
      <td dir="ltr">{row.transferNos.join('، ')||'—'}</td>
      <td dir="ltr">{num(row.sapQuantity)}</td>
      <td dir="ltr">{row.nearestWholePiece}</td>
      <td dir="ltr">{row.pieceDifference>0?'+':''}{num(row.pieceDifference)}</td>
      <td dir="ltr">{row.suspectedSapRounding&&row.amountDifferenceFils!==null
        ?(row.amountDifferenceFils>0?'+':'')+money(row.amountDifferenceFils)+' د.أ':'غير محسوم'}</td>
      <td>{row.suspectedSapRounding?'احتمال تقريب SAP':'كسر بحاجة مراجعة'}</td>
    </tr>)}</tbody>
  </table></div>
  <p>الأرقام أعلاه تقديرية للمراجعة وليست تصحيحًا محاسبيًا. الكسور غير المحسومة لا تدخل في مجموع أثر التقريب. احتفظ بمرجع الترحيل وراجع فروقات الزيادة والنقص عند إقفال الشهر.</p>
</div>}
<div className="save-actions"><div><Badge state={result.status} label={acceptedDifference?'مطابق باعتمادك':undefined}/><small>{acceptedDifference?'تم اعتماد فرق القيمة: '+money(result.priceDifference)+' دينار. احفظ لتثبيت الاعتماد.':'يمكن حفظ مجموعة تحتاج مراجعة والعودة لإكمالها.'}</small></div>{result.status==='difference'&&result.total!==null&&result.expected!==null&&<button type="button" className="button secondary" disabled={busy} onClick={()=>{
  change({acceptedDifference:{paper:result.total!,calculated:result.expected!}});
}}><Check size={16}/>اعتماد المطابقة رغم الفرق</button>}
{acceptedDifference&&<button type="button" className="button secondary" disabled={busy} onClick={()=>change({acceptedDifference:undefined})}>إلغاء اعتماد الفرق</button>}

<button className="button primary" disabled={busy} onClick={()=>void save()}><Save size={17}/>{busy?'جارٍ الحفظ…':draft.id?'حفظ التعديلات':'حفظ'}</button></div></section></>}
{tab==='history'&&<><div className="page-title"><div><p className="eyebrow">الأرشيف</p><h1>سجل المطابقة</h1><p>الترحيلات والفواتير محفوظة مع نتيجة المطابقة وأسعارها وقت الحفظ. تصدير Excel يشمل كل السجل حتى مع وجود بحث.</p></div><button className="button secondary" disabled={!historyRecords.some(r=>(JSON.parse(r.payload).invoices||[]).some((invoice:Invoice)=>invoiceDocumentNo(invoice.number)))} onClick={()=>window.print()}><Printer size={16}/>طباعة سجل المطابقات</button><button className="button secondary" disabled={busy||!records.length} onClick={exportFullHistory}><FileText size={16}/>تصدير السجل كامل Excel</button><button className="button secondary" onClick={()=>run(getRecords)}><RefreshCw size={16}/>تحديث</button></div><div className="search panel no-print"><Search size={17}/><input value={query} onChange={e=>Q(e.target.value)} placeholder="ابحث بالفرع أو رقم الترحيل أو الفاتورة"/></div>{historyRecords.map(r=>{const p=JSON.parse(r.payload);return <button key={r.id} className="record panel no-print" onClick={()=>loadRecord(r)}><span className="record-icon"><ClipboardPaste size={22}/></span><span><b>{r.branch}</b><small>ترحيلات: {p.transfers.map((t:any)=>t.number).join('، ')}</small><small>فواتير: {p.invoices.map((i:any)=>i.number).join('، ')}</small></span><span>{money(p.summary?.total??null)} د.أ</span><Badge state={r.status} label={!(p.invoices||[]).some((invoice:Invoice)=>invoiceDocumentNo(invoice.number))?'ترحيل بلا فاتورة زرقاء':p.summary?.acceptedDifference?'مطابق باعتمادك':undefined}/><span className="text-button">فتح الكشف ←</span></button>})}{!records.length&&<div className="panel empty">لا توجد ترحيلات أو فواتير محفوظة بعد.</div>}<InvoiceRegisterPrint records={historyRecords}/></>}
{tab==='invoices'&&<InvoiceRegister records={records} busy={busy} refresh={()=>run(getRecords)} open={loadRecord}/>}
{tab==='serial-soldier'&&<SerialSoldier syncVersion={sync.signal.version} syncScope={sync.signal.scope} branches={branches}/>}
{tab==='monthly'&&<><div className="page-title"><div><p className="eyebrow">إقفال الشهر</p><h1>مطابقة ترحيلات M2026</h1><p>تُقرأ ترحيلات SAP المحفوظة من ملفات SAP وتُقارن مع سجل الموقع للشهر المحدد.</p></div><button className="button secondary" onClick={()=>run(getRecords)}><RefreshCw size={16}/>تحديث المحفوظ</button></div><section className="panel"><div className="section-title"><CalendarDays size={21}/><h2>كشف الترحيلات الشهري</h2></div><div className="form-grid"><label>الشهر<input type="month" value={month} onChange={e=>{M(e.target.value);FILTERED(false);MR(false)}}/></label><label>تنسيق التاريخ في الكشف<select value={dateFormat} onChange={e=>DF(e.target.value)}><option value="dmy">يوم / شهر / سنة</option><option value="mdy">شهر / يوم / سنة</option></select></label></div><p className="hint">المصدر: {monthlySource||'جارٍ تحميل الكشف المشترك…'}</p><a className="button secondary" href="/reconciliation?view=sap-files">ملفات SAP — إدارة الكشف</a><label>كشف SAP المحفوظ<textarea className="serial-input" dir="ltr" value={serial} readOnly/></label>{serial&&!numbersOnly&&<div className="form-grid">{(['number','date','branch'] as const).map(k=><label key={k}>{k==='number'?'عمود رقم الترحيل':k==='date'?'عمود التاريخ':'عمود الفرع (اختياري)'}<select value={columns[k]} onChange={e=>COLS({...columns,[k]:Number(e.target.value)})}><option value={-1}>غير محدد</option>{heads.map((h,i)=><option key={i} value={i}>{h||'عمود '+(i+1)}</option>)}</select></label>)}</div>}<label className="check-label"><input type="checkbox" checked={filtered} onChange={e=>FILTERED(e.target.checked)}/>الكشف مفلتر من أول الشهر المحدد إلى آخره (مطلوب إذا لم يوجد عمود تاريخ)</label><button className="button primary" disabled={busy||!serial.trim()} onClick={()=>run(async()=>{await getRecords();MR(true)})}><Search size={17}/>مطابقة كشف الشهر</button></section>{monthReady&&<>{monthResult.problems.length>0&&<div className="banner error"><div><b>نتيجة غير مكتملة؛ راجع التالي:</b>{monthResult.problems.map((p,i)=><p key={i}>{p}</p>)}</div></div>}{monthResult.warnings?.map((warning,i)=><p className="amber" key={i}>{warning}</p>)}<div className="monthly-stats">{[['missing','غير مسجلة هنا',monthResult.missing.length],['pending','فواتير غير مكتملة',monthResult.pending.length],['received','فواتير مسجلة',monthResult.received.length],['extra','محفوظة خارج الكشف',monthResult.extra.length],['canceled','ملغاة على SAP',monthResult.canceled.length],['toCancel','كاش فان — حالة الإلغاء',monthResult.toCancel.length],['reverse','ترحيلات عكسية',monthResult.reverse.length]].map(([key,label,n])=><button key={key} className={'stat '+(monthTab===key?'selected':'')} onClick={()=>MT(String(key))}><span>{label}</span><strong>{n}</strong></button>)}</div><section className="panel"><h2>{monthTab==='missing'?'ترحيلات في الكشف لم تُسجّل فواتيرها هنا':monthTab==='pending'?'ترحيلات محفوظة وفواتيرها غير مكتملة':monthTab==='received'?'ترحيلات لها فواتير مسجلة':monthTab==='canceled'?'الترحيلات الملغاة وحركات إلغائها':monthTab==='toCancel'?'ترحيلات الكاش فان — حالة الإلغاء والترحيل المقابل':monthTab==='reverse'?'ترحيلات عكسية خارجة من المؤسسة':'ترحيلات محفوظة للشهر لا تظهر في الكشف'}</h2><div className="table-scroll"><table><thead><tr><th>رقم الترحيل</th><th>التاريخ</th><th>الفرع</th><th>الملاحظة</th>{monthTab==='toCancel'&&<><th>مرحل</th><th>حالة الإلغاء على SAP</th><th>الترحيل المقابل</th></>}<th/></tr></thead><tbody>{(monthResult[monthTab as 'missing'|'pending'|'received'|'extra'|'canceled'|'toCancel'|'reverse'] as any[]||[]).map((r:any)=><tr key={r.number}><td><code>{r.number}</code></td><td>{r.date}</td><td>{r.branch||r.group?.branch||'—'}</td><td>{r.reason||'—'}{monthTab==='toCancel'&&r.remarks&&<small dir="auto" style={{display:'block'}}>Remarks: {r.remarks}</small>}</td>{monthTab==='toCancel'&&<><td>{r.posted||'—'}</td><td><b className={r.cancellationStatus==='تم الإلغاء'?'green':r.cancellationStatus==='غير ملغي'?'red':'amber'}>{r.cancellationStatus||'لم يثبت الإلغاء'}</b></td><td>{r.counterpart?<><code>{r.counterpart}</code><small style={{display:'block'}}>{r.counterpartKind||''}</small></>:'—'}</td></>}<td>{r.group&&<button className="button secondary small" onClick={()=>loadRecord(r.group)}>فتح الكشف</button>}</td></tr>)}</tbody></table>{!(monthResult[monthTab as 'missing'|'pending'|'received'|'extra'|'canceled'|'toCancel'|'reverse'] as any[]||[]).length&&<div className="empty">لا توجد ترحيلات بهذه الفئة.</div>}</div><p className="hint">وجود فواتير مسجلة لا يعني تطابق كمياتها؛ افتح الكشف لعرض نتيجته. «غير مسجلة» تعني غيابها عن سجل هذا الموقع. الترحيل العكسي لا يساوي إلغاء SAP؛ علامة «تم الإلغاء» تحتاج CANCELED=Y أو مستند إلغاء صريح. «مرحل» تعني أن الترحيل موجود في الكشف الملصوق وليست مراجعة حية لـ SAP.</p>{monthResult.duplicates.length>0&&<p className="amber">أرقام مكررة في الكشف حُسبت مرة واحدة: {monthResult.duplicates.join('، ')}</p>}{monthResult.outside.length>0&&<p className="hint">استُبعد {monthResult.outside.length} سطرًا بتاريخ خارج الشهر المحدد.</p>}</section></>}</>}
{tab==='reference'&&<><div className="page-title"><div><p className="eyebrow">قائمة المؤسسة المعتمدة</p><h1>الأصناف والأسعار والشدّات</h1><p>{reference.filter(r=>r.active).length} صنفًا مفعّلًا. رقم المؤسسة لا يتغير بتغيّر تسمية SAP.</p></div><button className="button primary" onClick={newDefinition}><Plus size={16}/>إضافة صنف</button></div><div className="banner info">الأسعار والتسميات من نموذج المؤسسة؛ شدّات SAP من ملف المستودع. FVL00311 شدّته 8 حبات. الأصناف غير المربوطة تحتاج تعريفًا صريحًا ولا تُربط بتشابه الاسم.</div>{(referenceAudit.missingPrices.length>0||referenceAudit.packDifferences.length>0)&&<div className="banner info" role="status"><b>مراجعة جودة مرجع المؤسسة — دون تعديل تلقائي:</b>
 {referenceAudit.missingPrices.length>0&&<p>{referenceAudit.missingPrices.length} صنفًا مفعّلًا دون سعر: {referenceAudit.missingPrices.map(row=>row.sapCode+' ('+row.code+')').join('، ')}. لا تعتمد قيمته المالية قبل تحديد سعره.</p>}
 {referenceAudit.packDifferences.length>0&&<p>اختلاف شدّة المؤسسة عن شدّة SAP في {referenceAudit.packDifferences.length} صنف: {referenceAudit.packDifferences.map(row=>row.sapCode+' (المؤسسة '+row.invoicePack+' / SAP '+row.cartonPieces+')').join('، ')}. قد يكون الاختلاف مقصودًا؛ ثبّت الشدّتين من مصادرهما قبل تعديل المرجع.</p>}
 </div>}<div className="search panel"><Search size={17}/><input value={query} onChange={e=>Q(e.target.value)} placeholder="ابحث برقم المؤسسة أو كود SAP أو الاسم"/></div><section className="panel table-scroll"><table><thead><tr><th>رقم المؤسسة</th><th>رقم SAP</th><th>تسمية المؤسسة</th><th>سعر الحبة</th><th>حبات كرتونة SAP</th><th>وحدة المرجع / المستودع</th><th>وزن الحبة KG</th><th>الحالة</th><th/></tr></thead><tbody>{reference.filter(r=>(r.name+' '+r.code+' '+r.sapCode).toLowerCase().includes(query.toLowerCase())).map(r=><tr key={r.code}><td><code>{r.code}</code></td><td><code>{r.sapCode}</code></td><td className="name-cell">{r.name}</td><td>{money(r.price)}</td><td>{r.cartonPieces??'غير محدد'}</td><td>{r.sapUnit} / {r.warehouseUnit||'غير موجود'}</td><td>{r.kgPerPiece??'غير محدد'}</td><td>{r.active?'مفعّل':'موقوف'}</td><td><button className="button secondary small" disabled={busy} onClick={()=>openDefinition(r.code)}>تعديل</button></td></tr>)}</tbody></table></section></>}
</>}<footer>مركز الكيلاني للأغذية <span>·</span> مطابقة المؤسسة</footer></main></div>{(error||notice)&&<div className="modal-backdrop notification-backdrop"><section className="modal panel notification-dialog" role="alertdialog" aria-modal="true" aria-labelledby="notification-title"><div className="notification-heading">{error?<AlertTriangle size={22}/>:<CheckCircle2 size={22}/>}<h2 id="notification-title">{error?'تنبيه':'تم'}</h2></div><p>{error||notice}</p><div className="notification-actions"><button type="button" className="button primary" onClick={()=>{if(error)E('');else N('')}}>حسنًا</button></div></section></div>}{transferConflict&&<div className="modal-backdrop notification-backdrop"><section className="modal panel notification-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-conflict-title"><h2 id="transfer-conflict-title">الترحيل مسجّل مسبقًا</h2><p>الترحيل {transferConflict.number} موجود في السجل.</p><div className="notification-actions"><button type="button" className="button primary" onClick={()=>{if(!confirm('فتح الترحيل المحفوظ؟ احفظ تعديلاتك الحالية قبل الانتقال إذا لزم.'))return;const id=transferConflict.id;setTransferConflict(null);void loadRecord({id})}}>فتح الترحيل المحفوظ</button><button type="button" className="button secondary" onClick={()=>setTransferConflict(null)}>إغلاق</button></div></section></div>}{searchTransferOpen&&<div className="modal-backdrop">
  <section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="search-transfer-title">
    <div className="section-title"><Search size={21}/><h2 id="search-transfer-title">إضافة ترحيل برقم SAP</h2></div>
    <form onSubmit={event=>{
      event.preventDefault();
      void addTransferFromSavedFile();
    }}>
      <label>رقم الترحيل
        <input autoFocus disabled={searchTransferBusy} dir="ltr" inputMode="numeric" enterKeyHint="search"
          value={searchTransferNumber} placeholder="مثال: 2615835"
          onChange={event=>{
            setSearchTransferNumber(event.target.value);
            setSearchTransferError('');
            setSearchTransferMissing(false);setBranchMismatch(null);setBranchExceptionReason('');
          }}/>
      </label>
      <p className="hint">يمكن تصحيح فرع ترحيل محفوظ في كشف SAP دون رفع ملفات SAP من جديد. يُسجل الفرع الأصلي والفرع المختار والسبب للترحيل المحدد فقط؛ ولا يتغير أصل SAP.</p>
      <label>فرع المؤسسة الصحيح
        <select value={draft?.branch||''} disabled={searchTransferBusy} onChange={event=>change({branch:event.target.value})}>
          <option value="">اختر الفرع الصحيح</option>
          {branches.map(branch=><option key={branch} value={branch}>{branch}</option>)}
        </select>
      </label>
      <p className="hint">إذا كان الترحيل مرتبطًا بكشف آخر، افتح الكشف الصحيح أولًا حتى لا تتكرر الفاتورة أو الترحيل.</p>
      <label className="check-label"><input type="checkbox" checked={correctTransferInvoice} onChange={e=>setCorrectTransferInvoice(e.target.checked)}/>تصحيح ربط خاطئ — نقل الترحيل من فاتورته الحالية إلى هذا الكشف</label><p className="hint">افتح الفاتورة الصحيحة أولًا. يُنقل الترحيل عند الحفظ وتُحفظ نسخة السجل السابق للمراجعة.</p>
      {searchTransferError&&<p className="red" role="alert">{searchTransferError}</p>}
      {branchMismatch&&<div className="banner amber" role="group" aria-label="اعتماد استثناء اختلاف الفرع">
        <strong>استثناء اختلاف فرع الترحيل {branchMismatch.transferNo}</strong>
        <p>الفرع في المصدر: {branchMismatch.sourceBranches.join('، ')}. الفرع الصحيح الذي اخترته: {branchMismatch.targetBranch}.</p>
        <p>هذا استثناء للترحيل المحدد فقط. لا يعدّل بيانات SAP، ولا يتجاوز شروط تصحيح الفاتورة أو الترحيلات الملغاة.</p>
        <label>سبب الاستثناء (يُحفظ للمراجعة)
          <textarea value={branchExceptionReason} maxLength={500} rows={2}
            onChange={event=>setBranchExceptionReason(event.target.value)}
            placeholder="مثال: تم التحقق من الفاتورة الأصلية؛ الترحيل يخص هذا الفرع رغم اسم الفرع في SAP"/>
        </label>
        <p className="hint">اكتب سبب المراجعة الفعلي (8 أحرف على الأقل). رقم الترحيل وحده لا يكفي؛ إذا لم يُحفظ القرار ستظهر رسالة واضحة بدل الانتظار المستمر.</p>
        <button type="button" className="button secondary" disabled={searchTransferBusy}
          onClick={()=>void approveBranchMismatch()}>{branchExceptionSaving?'جارٍ حفظ استثناء الفرع…':'اعتماد استثناء الفرع وحفظ السبب'}</button>
      </div>}
      {searchTransferMissing&&<p role="alert">الترحيل غير موجود في السجل أو ملف TXT. يمكنك إدخال بنوده يدويًا.</p>}
      <div className="save-actions">
        {draft?.transfers.some(row=>transferNumbers(row.number).includes(digits(searchTransferNumber).trim()))&&
          <button type="button" className="button secondary" disabled={searchTransferBusy}
            onClick={()=>void reviewDraftTransferBranch()}>التحقق من تصحيح الفرع دون إضافة مكررة</button>}
        <button type="submit" className="button primary" disabled={searchTransferBusy}>
          {searchTransferBusy?(branchExceptionSaving?'جارٍ حفظ الاستثناء…':'جارٍ البحث…'):'بحث وإضافة'}
        </button>
        {searchTransferMissing&&<button type="button" className="button secondary" onClick={()=>{
          const number=digits(searchTransferNumber).trim();
          const placeholder=draft.transfers.find(row=>!row.number.trim()&&!row.paste.trim());
          stageTransfer({...newTransfer(),number},'',undefined,placeholder?.id);
          setSearchTransferOpen(false);
        }}>إضافة يدويًا</button>}
        <button type="button" className="button secondary" disabled={searchTransferBusy} onClick={()=>{setSearchTransferOpen(false);setBranchMismatch(null);setBranchExceptionReason('')}}>إلغاء</button>
      </div>
    </form>
  </section>
</div>}{duplicateTransfer&&<div className="modal-backdrop"><section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="duplicate-transfer-title"><div className="section-title"><AlertTriangle size={21}/><h2 id="duplicate-transfer-title">رقم الترحيل مكرر</h2></div><p>الترحيل {duplicateTransfer} موجود في الكشف. أدخل رقم ترحيل آخر.</p><button type="button" className="button primary" onClick={()=>setDuplicateTransfer('')}>حسنًا</button></section></div>}{missingTransfer&&<div className="modal-backdrop"><section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="missing-transfer-title"><div className="section-title"><AlertTriangle size={21}/><h2 id="missing-transfer-title">الترحيل غير موجود</h2></div><p>الترحيل {missingTransfer.number} غير موجود في كشف SAP أو السجل. هل تريد إضافته يدويًا؟</p><div className="save-actions"><button type="button" className="button primary" onClick={()=>{const index=draft?.transfers.findIndex(t=>t.id===missingTransfer.id)??-1;setMissingTransfer(null);if(index>=0)setTimeout(()=>document.querySelector<HTMLTextAreaElement>('[aria-label="جدول SAP '+(index+1)+'"]')?.focus(),0)}}>إضافة يدويًا</button><button type="button" className="button secondary" onClick={()=>setMissingTransfer(null)}>إلغاء</button></div></section></div>}
{edit&&sapDefinition&&<div className="modal-backdrop">
  <section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="institution-definition-title">
    <div className="section-title">
      <Settings2 size={21}/>
      <h2 id="institution-definition-title">{linkSap?'ربط صنف SAP بالمؤسسة':'تعريف صنف المؤسسة'}</h2>
      <button type="button" className="icon-button" aria-label="إغلاق" disabled={busy} onClick={closeEdit}>×</button>
    </div>
    {error&&<div className="banner error" role="alert">{error}</div>}
    <p className="hint">{linkSap
      ?'أدخل رقم المادة بالمؤسسة. إذا كان الرقم موجودًا، يُضاف كود SAP لهذا الصنف وتحدد شدّة الكود الجديد حسب الحاجة.'
      :'يُحفظ التعديل في المرجع. تحتفظ الكشوف المحفوظة بقيمها المسجلة وقت الحفظ.'}</p>
    {linkSap&&<div className="panel">
      <label>ابحث عن صنف المؤسسة لربطه
        <input type="search" value={linkQuery} onChange={e=>setLinkQuery(e.target.value)} placeholder="رقم المؤسسة أو كود SAP أو اسم الصنف"/>
      </label>
      {linkQuery.trim()&&<div className="link-search-results">
        {reference.filter(item=>item.active&&digits(item.code+' '+item.sapCode+' '+item.name+' '+(item.sapAliases||[]).map(alias=>alias.sapCode).join(' ')).toLowerCase().includes(digits(linkQuery).trim().toLowerCase())).slice(0,10).map(item=>
          <button type="button" className="button secondary small" key={item.code} onClick={()=>{EDIT({...edit,code:item.code});setLinkQuery('')}}>
            {item.code} · {item.name} · {item.sapCode}
          </button>)}
        <p className="hint">اختر الصنف الصحيح، أو أدخل رقم المادة أدناه لتعريف صنف جديد.</p>
      </div>}
    </div>}
    <p className="hint">سعر العقبة الذي تحفظه هنا يُستخدم مباشرة في مطابقة العقبة ويظهر في مرجع أسعارها.</p>
    <div className="two-fields">
      <label>رقم المادة بالمؤسسة
        <input dir="ltr" value={edit.code} disabled={Boolean(editOriginal)} onChange={e=>EDIT({...edit,code:e.target.value})}/>
      </label>
      <label>كود SAP
        <input dir="ltr" value={sapDefinition.sapCode} disabled={Boolean(linkSap||editAlias)}
          onChange={e=>updateSapDefinition({sapCode:e.target.value.toUpperCase()})}/>
      </label>
    </div>
    {!linkSap&&Boolean(edit.sapAliases?.length)&&<label>التعريف حسب كود SAP
      <select value={editAlias} onChange={e=>setEditAlias(e.target.value)}>
        <option value="">{edit.sapCode}</option>
        {edit.sapAliases?.map(alias=><option key={alias.sapCode} value={alias.sapCode}>{alias.sapCode}</option>)}
      </select>
    </label>}
    {aliasTarget
      ?<p>ربط بكود إضافي للصنف <b>{aliasTarget.name}</b> ({aliasTarget.code}). {aqabaEditor?'سعر العقبة مستقل عن سعر المؤسسة.':'سيُستخدم سعر الحبة المسجل للصنف.'}</p>
      :<label>تسمية المؤسسة<input value={edit.name} onChange={e=>EDIT({...edit,name:e.target.value})}/></label>}
    <div className="two-fields">
      {!aliasTarget&&!aqabaEditor&&<label>سعر المؤسسة للحبة بالدينار
        <input type="number" step="0.001" min="0" value={edit.price===null?'':edit.price/1000}
          onChange={e=>EDIT({...edit,price:e.target.value===''?null:Math.round(Number(e.target.value)*1000)})}/>
      </label>}
      <label>سعر العقبة للحبة بالدينار
        <input inputMode="decimal" dir="ltr" value={aqabaPriceInput} placeholder="0.000"
          onChange={e=>{setAqabaPriceInput(e.target.value);setAqabaPriceDirty(true)}}/>
      </label>
      <label>حبات كرتونة SAP
        <input type="number" min="1" value={sapDefinition.cartonPieces??''}
          onChange={e=>updateSapDefinition({cartonPieces:e.target.value===''?null:Number(e.target.value)})}/>
      </label>
      <label>وحدة SAP في المرجع
        <select value={sapDefinition.sapUnit} onChange={e=>updateSapDefinition({sapUnit:e.target.value})}>
          <option>Piece</option><option>Carton</option><option>KG</option>
        </select>
      </label>
      <label>وزن الحبة بالكغم (لتحويل KG)
        <input type="number" step="any" min="0.000001" value={sapDefinition.kgPerPiece??''}
          onChange={e=>updateSapDefinition({kgPerPiece:e.target.value===''?null:Number(e.target.value)})}/>
      </label>
    </div>
    <label className="check-label">
      <input type="checkbox" checked={edit.active} disabled={Boolean(linkSap)} onChange={e=>EDIT({...edit,active:e.target.checked})}/>
      الصنف ضمن قائمة المؤسسة المفعّلة
    </label>
    {editOriginal&&<button type="button" className="button secondary" disabled={busy||!aqabaPriceInput.trim()} onClick={()=>void saveItem(true)}>
      <Save size={16}/>حفظ سعر العقبة فقط
    </button>}
    <button type="button" className="button primary" disabled={busy} onClick={()=>void saveItem()}>
      <Save size={16}/>{linkSap?'حفظ الربط والسعر':'حفظ التعريف والأسعار'}
    </button>
  </section>
</div>}</div>}
