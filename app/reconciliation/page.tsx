'use client';
import {useEffect,useMemo,useState} from 'react';
import SapImport from './SapImport';
import GroupLookup from './GroupLookup';
import InvoiceRegister,{InvoiceRegisterPrint} from './InvoiceRegister';
import WorkspaceNav from '../../components/WorkspaceNav';
import './reconciliation.css';
import {ArrowLeftRight,Check,CheckCircle2,AlertTriangle,Plus,Trash2,ClipboardPaste,FileText,CalendarDays,History,Settings2,Search,Save,Printer,Upload,ChevronDown,ArrowUpRight,RefreshCw,Copy,PackageCheck} from 'lucide-react';
import {reconcile,withInvoiceDates,sapReferences,checkSignature,groupReference,moveLinkedPage,parseTransfer,monthly,serialHeaders,isTransferNumber,pageNumber,digits,numeric,fils,money,num,labels,type Draft,type Item,type Invoice} from '../lib/reconcile';
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Amman'});
const uid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const newInvoice=():Invoice=>({id:uid(),number:'',date:'',amount:'',complete:false,quantities:{},attachments:[]});
const newTransfer=()=>({id:uid(),number:'',date:today(),paste:''});
type OrderedDraft = Draft & {pageEntryOrder?: string[]};
const blank=():OrderedDraft=>({mode:'manual',checks:{},branch:'',driver:'',date:today(),transfers:[newTransfer()],invoices:[newInvoice()],notes:''});
async function api(body?:any,url=''){const r=await fetch('/api/reconcile'+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const data:any=await r.json();if(!r.ok)throw Error(data.error||'تعذر تنفيذ الطلب');return data}
function Badge({state,label}:{state:string;label?:string}){return <span className={'badge '+state}>{state==='match'?<Check size={13}/>:<AlertTriangle size={13}/>} {label||labels[state]||state}</span>}
function TransferCard({transfer,index,onChange,onRemove,onLookup}:{transfer:any,index:number,onChange:(t:any)=>void,onRemove:()=>void,onLookup:(number:string)=>void}){const parsed=useMemo(()=>parseTransfer(transfer.paste,{allowReverse:true}),[transfer.paste]);return <section className="transfer-card"><div className="card-title"><span className="number">{index+1}</span><b>الترحيل {index+1}</b>{index>0&&<button className="icon-button danger" aria-label={'حذف الترحيل '+(index+1)} onClick={onRemove}><Trash2 size={16}/></button>}</div><div className="two-fields"><label>رقم الترحيل<input value={transfer.number} onChange={e=>onChange({...transfer,number:e.target.value})} onBlur={e=>{if(e.target.value.trim()&&!transfer.paste.trim())onLookup(e.target.value.trim())}} placeholder="مثال: 2615835"/></label><label>تاريخ الترحيل<input type="date" value={transfer.date} onChange={e=>onChange({...transfer,date:e.target.value})}/></label></div><label className="paste-label">جدول SAP<textarea aria-label={'جدول SAP '+(index+1)} value={transfer.paste} onChange={e=>onChange({...transfer,paste:e.target.value})} placeholder={'الصق جدول الترحيل مع العناوين هنا…\nItem No.    Quantity    UoM Name    From Warehouse    To Warehouse'} dir="ltr"/></label><div className="paste-summary">{transfer.paste?<><span><CheckCircle2 size={14}/>{parsed.lines.length} بند صالح</span>{parsed.lines.some(line=>line.from==='011')&&<span>ترحيل عكسي · يُخصم من الصافي</span>}{parsed.issues.length>0&&<span className="red">{parsed.issues.length} ملاحظات قراءة</span>}{parsed.excluded.length>0&&<span className="amber">{parsed.excluded.length} خارج مسارات المؤسسة</span>}</>:<span>نسخ من SAP ← لصق هنا. تُقرأ Quantity فقط.</span>}</div>{parsed.issues.length>0&&<details><summary>ملاحظات قراءة الترحيل</summary>{parsed.issues.map((p,i)=><p className="red" key={i}>{p}</p>)}</details>}{parsed.excluded.length>0&&<details><summary>بنود خارج نطاق المؤسسة</summary>{parsed.excluded.map((p,i)=><p key={i}>{p}</p>)}</details>}</section>}
export default function Home(){const [reference,REF]=useState<Item[]>([]),[branches,BR]=useState<string[]>([]),[drivers,DR]=useState<string[]>([]),[draft,D]=useState<OrderedDraft|null>(null),[tab,T]=useState('work'),[loading,L]=useState(true),[busy,B]=useState(false),[error,E]=useState(''),[notice,N]=useState(''),[records,REC]=useState<any[]>([]),[query,Q]=useState(''),[onlyDiff,DIFF]=useState(false),[sort,SORT]=useState('entry'),[pageFilter,PAGE]=useState('all'),[pick,PICK]=useState(''),[edit,EDIT]=useState<Item|null>(null),[linkSap,LINK]=useState(''),[importTexts,IT]=useState<Record<string,string>>({}),[month,M]=useState(today().slice(0,7)),[serial,SERIAL]=useState(''),[columns,COLS]=useState({number:-1,date:-1,branch:-1}),[filtered,FILTERED]=useState(false),[dateFormat,DF]=useState('dmy'),[monthTab,MT]=useState('missing'),[monthReady,MR]=useState(false);
useEffect(()=>{D(blank());const view=new URLSearchParams(window.location.search).get('view');if(['history','invoices','monthly','reference'].includes(view||'')){T(view!);if(view==='history'||view==='invoices'||view==='monthly')getRecords().catch(e=>E(e.message));}api().then(x=>{REF(x.reference);BR(x.branches);DR(x.drivers)}).catch(e=>E(e.message)).finally(()=>L(false))},[]);
const result=useMemo(()=>draft?reconcile(draft,groupReference(draft.useCurrentReference?undefined:draft.referenceSnapshot,reference,draft.linkedSapCodes)):null,[draft,reference]);const heads=serialHeaders(serial);
const numbersOnly=serial.trim()!==''&&serial.trim().split(/\r?\n/).filter(line=>line.trim()).every(isTransferNumber);
const selectedPage=pageFilter==='all'?null:Number(pageFilter);
const reusableLink=linkSap?sapReferences(reference).find(item=>item.sapCode===linkSap&&item.active):undefined;
const aliasTarget=linkSap&&edit?reference.find(item=>item.code===digits(edit.code).trim()&&item.sapCode!==linkSap):undefined;
const selectedInvoice=selectedPage&&draft?draft.invoices[selectedPage-1]:undefined;
const getPage=(key:string)=>draft?.invoices.length===1?1:pageNumber(draft?.pages?.[key]);
const entryPositions=new Map(draft?.pageEntryOrder?.map((key,index)=>[key,index]));
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
const pageExpected=pageRows.length>0&&pageRows.every(row=>row.expected!==null)?pageRows.reduce((sum,row)=>sum+row.expected!,0):null;
const pageAmount=selectedInvoice?fils(selectedInvoice.amount):null;
const expected=selectedPage===null?result?.expected??null:pageExpected;
const paperAmount=selectedPage===null?result?.total??null:pageAmount;
const difference=paperAmount===null||expected===null?null:paperAmount-expected;
const acceptedDifference=!!result&&'acceptedDifference' in result&&result.acceptedDifference===true;
const comparisonLabel=selectedPage===null?'مطابقة إجمالي المجموعة':'مطابقة الفاتورة '+selectedPage;
const pageOptions=[...new Set([0,...(draft?.invoices.map((_,i)=>i+1)||[]),...sortedRows.map(row=>getPage(row.key))])].sort((a,b)=>a-b);const monthResult=useMemo(()=>monthly(serial,month,columns,filtered,dateFormat,records),[serial,month,columns,filtered,dateFormat,records]);
async function run(fn:()=>Promise<void>){B(true);E('');N('');try{await fn()}catch(e:any){E(e.message)}finally{B(false)}}
function change(p:Partial<OrderedDraft>){
  D(d=>{
    if(!d)return d;
    const next={...d,...p,...(p.branch!==undefined&&p.branch!==d.branch?{checks:{}}:{})};
    return p.transfers||p.invoices?withInvoiceDates(next):next;
  });
}
function invoiceChange(index:number,p:Partial<Invoice>){if(!draft)return;change({invoices:draft.invoices.map((v,i)=>i===index?{...v,...p}:v)})}
async function lookupTransfer(index:number,number:string){if(!draft||!number.trim())return;const normalized=digits(number).trim();if(draft.transfers.some((t,i)=>i!==index&&digits(t.number).trim()===normalized)){E('رقم الترحيل موجود مسبقًا في هذه المجموعة؛ لن يتم تكراره.');return}try{const found=await api(undefined,'?transfer='+encodeURIComponent(normalized));const transfer=found.transfer;if(!transfer?.paste?.trim()){E('الترحيل محفوظ بدون جدول أصناف؛ لا يمكن تعبئته تلقائيًا.');return}D(current=>{if(!current||digits(current.transfers[index]?.number||'').trim()!==normalized||current.transfers[index]?.paste?.trim())return current;return {...current,transfers:current.transfers.map((t,i)=>i===index?{...t,paste:transfer.paste,date:t.date||transfer.date}:t)}});E('');N('تم استرجاع أصناف الترحيل '+normalized+' من الاستيراد المحفوظ. راجع الفاتورة الزرقاء قبل الحفظ.')}catch(error:any){E(error.message||'تعذّر استرجاع الترحيل')}}
async function getRecords(){const x=await api(undefined,'?records=1');REC(x.records)}
async function loadRecord(r:any){await run(async()=>{const x=await api(undefined,'?id='+encodeURIComponent(r.id)),p=JSON.parse(x.record.payload);D(withInvoiceDates({...p,mode:'manual',checks:p.checks||{},id:x.record.id,version:x.record.version,useCurrentReference:false}));PAGE('all');Q('');T('work');N('تم فتح المجموعة بمرجعها وقت الحفظ. يمكنك إعادة المطابقة بالمرجع الحالي.');E('')})}
function openLink(row:NonNullable<typeof result>['rows'][number]){
  const existing=sapReferences(reference).find(item=>item.sapCode===row.sapCode);
  LINK(row.sapCode);
  EDIT(existing?{...existing,active:true}:{code:'',sapCode:row.sapCode,name:row.name.trim(),price:null,invoicePack:null,cartonPieces:null,sapUnit:row.details[0]?.unit||'Piece',warehouseUnit:null,kgPerPiece:null,active:true});
  E('');
}
function closeEdit(){EDIT(null);LINK('');E('')}
async function saveItem(){
  if(!edit)return;
  await run(async()=>{
    if(linkSap){
      const item={...edit,code:digits(edit.code).trim(),name:edit.name.trim()};
      const response=reusableLink?{reference}:await api({action:'linkReference',item});
      const linked=sapReferences(response.reference).find(entry=>entry.sapCode===linkSap&&entry.active);
      if(!linked)throw Error('تعذر تطبيق الربط على الكشف.');
      REF(response.reference);
      D(d=>{
        if(!d)return d;
        const source='s:'+linked.sapCode,target='i:'+linked.code;
        const moveOrder=pageNumber(d.pages?.[target])===0;
        const pageEntryOrder=d.pageEntryOrder?.flatMap(key=>key===source?(moveOrder?[target]:[]):[key]);
        return {...d,pages:moveLinkedPage(d.pages,linked.sapCode,linked.code),pageEntryOrder,linkedSapCodes:[...new Set([...(d.linkedSapCodes||[]),linked.sapCode])]};
      });
      closeEdit();
      N('تم ربط الصنف وتحديث الكشف. احفظ المجموعة لتسجيل التعديل فيها.');
      return;
    }
    const exists=reference.some(r=>r.code===edit.code);
    const items=exists?reference.map(r=>r.code===edit.code?edit:r):[...reference,edit];
    await api({action:'reference',items});
    REF(items);
    change({useCurrentReference:true});
    closeEdit();
    N('تم حفظ تعريف الصنف وتطبيق المرجع الحالي على المجموعة المفتوحة');
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
function checkInvoicePage(){
  if(!selectedInvoice||difference!==0)return;
  D(current=>{
    if(!current)return current;
    const checks={...current.checks};
    for(const row of pageRows)checks[row.key]={state:'match',signature:checkSignature(row)};
    return {...current,checks};
  });
}
function removeInvoice(index:number){
  if(!draft)return;
  const removedPage=index+1;
  const pages=Object.fromEntries(Object.entries(draft.pages||{}).map(([key,value])=>{
    const page=pageNumber(value);
    return [key,page===removedPage?'':page>removedPage?String(page-1):value];
  }));
  change({invoices:draft.invoices.filter((_,i)=>i!==index),pages,pageEntryOrder:draft.pageEntryOrder?.filter(key=>pageNumber(pages[key])>0)});
  if(selectedPage===removedPage)PAGE('0');
  else if(selectedPage!==null&&selectedPage>removedPage)PAGE(String(selectedPage-1));
}
function assignPage(key:string,raw:string){
  const value=digits(raw).trim();
  const page=pageNumber(value);
  if((value&&!/^\d{1,2}$/.test(value))||page>30)return;
  D(d=>{
    if(!d)return d;
    const order=d.pageEntryOrder||[];
    if(page===pageNumber(d.pages?.[key])&&(!page||order.includes(key)))return d;
    const pageEntryOrder=order.filter(entry=>entry!==key);
    if(page)pageEntryOrder.push(key);
    const invoices=[...d.invoices];
    while(invoices.length<page)invoices.push(newInvoice());
    return {...d,pages:{...d.pages,[key]:page?String(page):''},invoices,pageEntryOrder};
  });
}
function finishFirstPage(){
  const keys=result?.rows.map(row=>row.key)??[];
  D(d=>{
    if(!d)return d;
    const pages={...d.pages};
    const remaining=keys.filter(key=>pageNumber(pages[key])===0);
    if(!remaining.length)return d;
    for(const key of remaining)pages[key]='2';
    const invoices=d.invoices.length<2?[...d.invoices,newInvoice()]:d.invoices;
    return {...d,pages,invoices};
  });
  PAGE('2');
  Q('');
}
function exportText(){if(!result)return;const header=['رقم المادة','الفاتورة الزرقاء','رقم الفاتورة الحقيقي','اسم المادة','الكمية بالحبة','السعر','القيمة','كود SAP'];const rows=[header,...visibleRows.map(r=>[r.code,String(getPage(r.key)),draft?.invoices[getPage(r.key)-1]?.number||'',r.name,num(r.transfer),money(r.unitPrice),money(r.expected),r.sapCode])];const txt='\ufeff'+rows.map(r=>r.join('\t')).join('\r\n');const blob=new Blob([txt],{type:'text/tab-separated-values;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='institution-check-sheet'+(selectedPage===null?'':'-page-'+selectedPage)+'.tsv';a.click();URL.revokeObjectURL(url)}
async function save(){await run(async()=>{const savedDraft=draft&&draft.invoices.length===1&&result?{...draft,pages:{...draft.pages,...Object.fromEntries(result.rows.map(row=>[row.key,'1']))}}:draft;const x=await api({action:'save',draft:savedDraft});change({id:x.id,version:x.version,referenceSnapshot:x.referenceSnapshot,useCurrentReference:false,linkedSapCodes:undefined});N('تم حفظ المجموعة والفواتير والترحيلات في السجل.')})}
function setSerial(text:string){SERIAL(text);FILTERED(false);MR(false);const h=serialHeaders(text).map(h=>h.toLowerCase().replace(/[\s._:-]/g,''));COLS({number:h.findIndex(v=>['docnum','docno','documentnumber','documentno','transfernumber','transferno','#','رقمالترحيل','رقمالمستند','رقمالحركة'].includes(v)),date:h.findIndex(v=>['docdate','documentdate','postingdate','date','التاريخ','تاريخالمستند','تاريخالترحيل'].includes(v)),branch:h.findIndex(v=>['branch','branchname','الفرع','اسمالفرع'].includes(v))})}
if(!draft)return <div className="initial">جاري تجهيز مساحة المطابقة…</div>;
return <div className="recon-app"><header className="topbar"><a className="brand" href="/"><span className="brand-mark"><ArrowLeftRight size={22}/></span><span><b>إدارة المؤسسة</b><small>مركز الكيلاني للأغذية · مساحة عمل المؤسسة</small></span></a><div className="topbar-end"><span className="private-dot"/>مساحة عمل خاصة<span className="avatar">ك</span></div></header><div className="app-shell"><aside className="sidebar"><WorkspaceNav area="reconciliation" tab={tab} onSelect={key=>{E('');Q('');if(key==='history'||key==='invoices'||key==='monthly')run(async()=>{await getRecords();T(key)});else T(key)}}/><div className="sidebar-note"><PackageCheck size={28}/><b>من الترحيل إلى الفاتورة</b><p>كل الأصناف تُقارن بالحبة. الأكواد والشدّات من مراجعها المعتمدة.</p><span>001 / 002 <ArrowLeftRight size={12}/> 011</span></div><div className="sidebar-bottom">المؤسسة الاستهلاكية العسكرية</div></aside><main>{error&&<div className="banner error" role="alert"><AlertTriangle size={18}/><span>{error}</span><button onClick={()=>E('')}>×</button></div>}{notice&&<div className="banner success" role="status"><CheckCircle2 size={18}/>{notice}</div>}{loading?<section className="panel">جاري تحميل المرجع…</section>:<>
{tab==='work'&&result&&<><div className="page-title"><div><p className="eyebrow">مجموعات المطابقة / {draft.id?'مجموعة محفوظة':'مجموعة جديدة'}</p><h1>ألصق الترحيلات. ووزّع الأصناف على الفواتير الزرقاء.</h1><p>كشف بأكواد المؤسسة وتسمياتها وأسعارها، جاهز للمطابقة اليدوية.</p></div><button className="button secondary" onClick={()=>{if(draft.transfers.some(t=>t.paste.trim())&&!confirm('بدء مجموعة جديدة؟ احفظ التعديلات الحالية أولًا إذا أردت الاحتفاظ بها.'))return;D(blank());PAGE('all');Q('');N('');E('')}}><Plus size={16}/>مجموعة جديدة</button></div>{draft.id&&!draft.useCurrentReference&&<div className="banner info">المطابقة معروضة بمرجع الأسعار والشدّات وقت الحفظ.<button className="text-button" onClick={()=>change({useCurrentReference:true})}>إعادة المطابقة بالمرجع الحالي</button></div>}<div className="stats"><div className={'stat status-stat '+result.status}><span>نتيجة المجموعة</span><strong><Badge state={result.status} label={acceptedDifference?'مطابق باعتمادك':undefined}/></strong><small>{result.differences} فروقات أصناف · {result.review} بحاجة مراجعة</small></div><div className="stat"><span>مجموع مبالغ الفواتير</span><strong>{money(result.total)} <small>د.أ</small></strong><small>{draft.invoices.length} فواتير مرتبطة</small></div><div className="stat"><span>قيمة الترحيلات حسب أسعار المؤسسة</span><strong>{money(result.expected)} <small>د.أ</small></strong><small>{draft.transfers.length} ترحيلات مرتبطة</small></div><div className={'stat '+(result.priceDifference?'warn':'')}><span>فرق القيمة</span><strong dir="ltr">{money(result.priceDifference)} <small>د.أ</small></strong><small>الفواتير − قيمة الترحيلات</small></div></div><SapImport branches={branches} readRecords={async()=>{const data=await api(undefined,'?records=1');return data.records}} saveDraft={async imported=>{const data=await api({action:'save',draft:imported});return data.id}} openSaved={id=>loadRecord({id})} openDraft={imported=>{
  if((draft.id||draft.transfers.some(transfer=>transfer.paste.trim()))&&!confirm('فتح مجموعة الاستيراد؟ احفظ التعديلات الحالية أولًا إذا أردت الاحتفاظ بها.'))return;
  D(imported);PAGE('all');Q('');E('');N('تم تجهيز المجموعة من SAP. راجعها ثم احفظها.');
  document.getElementById('reconciliation-group')?.scrollIntoView({block:'start'});
}}/><section id="reconciliation-group" className="panel"><div className="section-title"><span className="step">01</span><div><h2>بيانات المجموعة</h2><p>جميع الفواتير والترحيلات هنا لنفس الفرع.</p></div></div><div className="form-grid"><GroupLookup label="فرع المؤسسة" required placeholder="اكتب اسم الفرع أو رقمه" items={branches} value={draft.branch} onChange={branch=>change({branch})}/><GroupLookup label="الشوفير" placeholder="اكتب اسم الشوفير أو رقمه (اختياري)" items={drivers} value={draft.driver} onChange={driver=>change({driver})}/><label>تاريخ المجموعة<input type="date" value={draft.date} onChange={e=>change({date:e.target.value})}/></label></div></section><section className="panel"><div className="section-title"><span className="step">02</span><div><h2>ترحيلات SAP</h2><p>أضف الترحيل العكسي برقم مستقل داخل نفس المجموعة. الترحيلات من 011 إلى 001 أو 002 تُخصم من الصافي.</p></div><button className="button secondary" onClick={()=>change({transfers:[...draft.transfers,newTransfer()]})}><Plus size={16}/>إضافة ترحيل</button></div><div className="cards-grid">{draft.transfers.map((t,i)=><TransferCard key={t.id} transfer={t} index={i} onChange={v=>change({transfers:draft.transfers.map((t,j)=>j===i?v:t)})} onRemove={()=>change({transfers:draft.transfers.filter((_,j)=>j!==i)})} onLookup={number=>lookupTransfer(i,number)}/>)}</div></section><section className="panel invoice-entry"><div className="section-title"><span className="step">03</span><div><h2>الفواتير الورقية المرتبطة</h2><p>الفاتورة 1 للأصناف التي وضعت لها 1، والفاتورة 2 للأصناف التي وضعت لها 2، وهكذا. اكتب رقم الفاتورة الورقية الحقيقي في الحقل المقابل.</p></div><button className="button secondary" disabled={draft.invoices.length>=30} onClick={()=>change({invoices:[...draft.invoices,newInvoice()]})}><Plus size={16}/>إضافة فاتورة</button></div><div className="invoice-grid">{draft.invoices.map((inv,i)=><article className="invoice-card" key={inv.id}><div className="card-title"><FileText size={18}/><input className="invoice-title-input" aria-label={'عنوان الفاتورة الزرقاء '+(i+1)} title="اضغط لتعديل عنوان الفاتورة" maxLength={80} value={inv.title??'الفاتورة الزرقاء '+(i+1)} onChange={e=>invoiceChange(i,{title:e.target.value})} onBlur={()=>{const title=inv.title?.trim()||undefined;if(title!==inv.title)invoiceChange(i,{title})}}/><button type="button" className="text-button" onClick={()=>{PAGE(String(i+1));Q('');document.getElementById('invoice-sheet')?.scrollIntoView({block:'start'})}}>عرض كشف الفاتورة {i+1}</button>{i>0&&<button className="icon-button danger" aria-label={'حذف الفاتورة '+(i+1)} onClick={()=>removeInvoice(i)}><Trash2 size={15}/></button>}</div><div className="invoice-fields"><label>رقم الفاتورة الورقية الحقيقي<input value={inv.number} onChange={e=>invoiceChange(i,{number:e.target.value,manualNumber:true})}/></label><label>مبلغ الفاتورة (د.أ)<input inputMode="decimal" value={inv.amount} onChange={e=>invoiceChange(i,{amount:e.target.value})} placeholder="0.000"/></label><div className="invoice-date-field"><label>{inv.manualDate?'تاريخ الفاتورة · تعديل يدوي':'تاريخ الفاتورة · قبل الترحيل بيوم'}<input type="date" value={inv.date} onChange={e=>invoiceChange(i,{date:e.target.value,manualDate:!!e.target.value})}/></label>{inv.manualDate&&<button type="button" className="text-button" onClick={()=>invoiceChange(i,{date:'',manualDate:false})}>رجوع للتاريخ التلقائي</button>}</div></div><label className="check-label"><input type="checkbox" checked={inv.complete} onChange={e=>invoiceChange(i,{complete:e.target.checked})}/>الفاتورة الورقية موجودة لدي</label></article>)}</div></section>
<section id="invoice-sheet" className="panel results-panel blue-invoice"><div className="section-title no-print"><span className="step">04</span><div><h2>كشف المؤسسة للمطابقة اليدوية</h2><p>حدد رقم الفاتورة الزرقاء لكل صنف. اضغط على الكمية لتعليمها كمُشيّكة، واضغط مرة ثانية لإلغاء العلامة.</p></div><button type="button" className="button secondary" disabled={!result.rows.some(row=>getPage(row.key)===0)} onClick={finishFirstPage}><Check size={16}/>خلصت من صفحة 1 — انقل الباقي إلى 2</button><button className="button secondary" onClick={exportText}><ArrowUpRight size={16}/>تصدير الكشف</button><button className="icon-button" aria-label="طباعة كشف المؤسسة" onClick={()=>window.print()}><Printer size={18}/></button></div>{result.problems.length>0&&<details className="review-list no-print"><summary>{result.problems.length} نقاط يلزم إكمالها قبل اعتماد المطابقة</summary>{result.problems.map((p,i)=><p key={i}>{p}</p>)}</details>}<div className="table-controls no-print"><div className="search"><Search size={16}/><input value={query} onChange={e=>Q(e.target.value)} aria-label="البحث في أصناف الفاتورة" placeholder="ابحث بآخر 4 أرقام من رقم المادة أو بالاسم…"/></div><select aria-label="ترتيب الأصناف" value={sort} onChange={e=>SORT(e.target.value)}><option value="entry">حسب ترتيب إدخال رقم الصفحة</option><option value="asc">رقم المادة تصاعدي</option><option value="desc">رقم المادة تنازلي</option></select><select aria-label="رقم الصفحة" value={pageFilter} onChange={e=>PAGE(e.target.value)}><option value="all">كل الصفحات</option>{pageOptions.map(page=><option key={page} value={page}>{page===0?'صفحة 0 · أصناف بلا رقم':'صفحة '+page+(draft.invoices[page-1]?.number?' · فاتورة '+draft.invoices[page-1].number:'')}</option>)}</select></div>
{selectedPage===0&&<p className="hint no-print">صفحة 0 تجمع الأصناف اللي ما حددت إلها رقم صفحة. اكتب 2 بجانب أصناف الفاتورة الثانية ثم اختر صفحة 2 لمقارنة مبلغها.</p>}
<div className="blue-paper"><div className="blue-heading"><h2>المؤسسة الاستهلاكية العسكرية</h2><h3>كشف مطابقة فاتورة صرف وهمي{selectedPage!==null?' · صفحة '+selectedPage:''}</h3><p>مُعدّ من ترحيلات SAP للمراجعة مقابل الفاتورة الأصلية</p></div><div className="blue-meta"><span>اسم السوق: <b>{draft.branch||'—'}</b></span><span>التاريخ: <b>{selectedInvoice?.date||draft.date}</b></span><span>أرقام الترحيلات: <b>{draft.transfers.map(t=>t.number||'—').join('، ')}</b></span><span>{selectedPage===null?'أرقام الفواتير':'رقم الفاتورة الورقية'}: <b>{selectedPage===null?draft.invoices.map(i=>i.number||'—').join('، '):selectedInvoice?.number||'—'}</b></span><span>اسم الشركة: <b>مركز الكيلاني للأغذية</b></span><span>السائق: <b>{draft.driver||'—'}</b></span></div>
<div className="table-scroll"><table className="blue-table"><thead><tr><th>ت</th><th>رقم المادة</th><th>الفاتورة الزرقاء</th><th>اسم المادة</th><th>صافي الكمية بالحبة</th><th>السعر</th><th>القيمة</th></tr></thead><tbody>{visibleRows.map((r,index)=>{
  const signature=r.transfer===null?'':checkSignature(r);
  const checked=draft.checks?.[r.key]?.state==='match'&&draft.checks[r.key].signature===signature;
  return <tr key={r.key} className={r.state}><td>{index+1}</td><td><code>{r.code||'غير مربوط'}</code><small className="sap-ref">{r.sapCode}</small></td><td><input key={getPage(r.key)} className="source-page-input no-print" type="text" inputMode="numeric" maxLength={2} aria-label={'رقم صفحة الصنف '+(r.code||r.sapCode)} placeholder="0" defaultValue={getPage(r.key)||''} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}} onChange={e=>{e.currentTarget.dataset.edited='true'}} onBlur={e=>{
    const input=e.currentTarget;
    if(!input.dataset.edited)return;
    delete input.dataset.edited;
    const value=digits(input.value).trim();
    if((value&&!/^\d{1,2}$/.test(value))||pageNumber(value)>30){
      input.value=String(getPage(r.key)||'');
      return;
    }
    assignPage(r.key,value);
    input.value=String(pageNumber(value)||'');
  }}/><span className="print-check">{getPage(r.key)}</span></td><td className="name-cell"><b>{r.name}</b>{r.details.length>0&&<details className="no-print"><summary>تفاصيل SAP</summary>{r.details.map((l,j)=><p key={j}>ترحيل {l.transferNo} · {l.quantity} {l.unit} · {l.from} ← {l.to}</p>)}</details>}{r.errors.map((e,j)=><small className="red" key={j}>{e}</small>)}{r.item?<button className="text-button" onClick={()=>EDIT({...r.item!})}>تعديل التعريف</button>:<button className="button secondary small no-print" onClick={()=>openLink(r)}>ربط الصنف</button>}</td><td className="qty">{r.transfer===null?num(r.transfer):<><button type="button" className="qty-check no-print" aria-pressed={checked} aria-label={'تشييك كمية '+r.name+'، '+num(r.transfer)+' حبة'} onClick={()=>toggleQuantityCheck(r.key,signature)}>{num(r.transfer)}</button><span className="print-check">{num(r.transfer)}</span></>}</td><td>{money(r.unitPrice)}</td><td>{money(r.expected)}</td></tr>})}</tbody></table>{result.rows.length>0&&!visibleRows.length&&<div className="empty">لا توجد أصناف ضمن العرض الحالي.</div>}{!result.rows.length&&<div className="empty"><ClipboardPaste size={35}/><h3>ألصق أول ترحيل ليظهر كشف المؤسسة</h3><p>الكميات تُحسب بالحبة من وحدات وشدّات SAP.</p></div>}</div>
<div className="blue-total">
  <b>{selectedPage===null?'قيمة أصناف كل الصفحات':selectedPage===0?'قيمة الأصناف غير الموزعة':'قيمة أصناف الفاتورة '+selectedPage}: {money(expected)} دينار</b>
  {selectedPage===0?<span>أصناف غير موزعة على الفواتير الورقية</span>:<>
    <span>{selectedPage===null?'مجموع مبالغ الفواتير الورقية':'مبلغ الفاتورة الورقية '+selectedPage}: {money(paperAmount)} دينار</span>
    <strong>فرق القيمة: {money(difference)} دينار</strong>
    <div className="blue-comparison">
      <span>{comparisonLabel}</span>
      {difference!==null?<Badge state={difference===0||(selectedPage===null&&acceptedDifference)?'match':'difference'} label={selectedPage===null&&acceptedDifference?'مطابق باعتمادك':undefined}/>:<small>{expected===null?'قيمة الأصناف غير مكتملة':'أدخل مبلغ الفاتورة الورقية لإظهار النتيجة'}</small>}
      {selectedInvoice&&<button type="button" className="button secondary small no-print" disabled={busy||difference!==0} onClick={checkInvoicePage}><Check size={14}/>تشييك كل أصناف الفاتورة</button>}
    </div>
  </>}
</div></div><p className="hint">رقم الفاتورة الزرقاء يحدد لأي ورقة ينتمي الصنف. اكتب رقم الفاتورة الورقية الحقيقي في بطاقة الفاتورة المقابلة، ولا تتغير كميات SAP أو الأسعار.</p>{query&&<p className="amber filter-warning">البحث يحدد البنود المعروضة والمطبوعة. الإجمالي يحسب كل أصناف الصفحة المختارة، أو كل أصناف المجموعة عند اختيار كل الصفحات.</p>}</section><section className="panel save-panel"><label>ملاحظات المجموعة<textarea value={draft.notes} maxLength={5000} onChange={e=>change({notes:e.target.value})} placeholder="أي ملاحظات على المستندات أو الفروقات…"/></label><div className="save-actions"><div><Badge state={result.status} label={acceptedDifference?'مطابق باعتمادك':undefined}/><small>{acceptedDifference?'تم اعتماد فرق القيمة: '+money(result.priceDifference)+' دينار. احفظ لتثبيت الاعتماد.':'يمكن حفظ مجموعة تحتاج مراجعة والعودة لإكمالها.'}</small></div>{result.status==='difference'&&result.total!==null&&result.expected!==null&&<button type="button" className="button secondary" disabled={busy} onClick={()=>{
  change({acceptedDifference:{paper:result.total!,calculated:result.expected!}});
}}><Check size={16}/>اعتماد المطابقة رغم الفرق</button>}
{acceptedDifference&&<button type="button" className="button secondary" disabled={busy} onClick={()=>change({acceptedDifference:undefined})}>إلغاء اعتماد الفرق</button>}
<button className="button primary" disabled={busy} onClick={save}><Save size={17}/>{busy?'جارٍ الحفظ…':draft.id?'حفظ التعديلات':'حفظ مجموعة المطابقة'}</button></div></section></>}
{tab==='history'&&<><div className="page-title"><div><p className="eyebrow">الأرشيف</p><h1>سجل مجموعات المطابقة</h1><p>الترحيلات والفواتير محفوظة مع نتيجة المطابقة وأسعارها وقت الحفظ.</p></div><button className="button secondary" disabled={!historyRecords.some(r=>(JSON.parse(r.payload).invoices||[]).some((invoice:Invoice)=>invoice.number?.trim()))} onClick={()=>window.print()}><Printer size={16}/>طباعة سجل المطابقات</button><button className="button secondary" onClick={()=>run(getRecords)}><RefreshCw size={16}/>تحديث</button></div><div className="search panel no-print"><Search size={17}/><input value={query} onChange={e=>Q(e.target.value)} placeholder="ابحث بالفرع أو رقم الترحيل أو الفاتورة"/></div>{historyRecords.map(r=>{const p=JSON.parse(r.payload);return <button key={r.id} className="record panel no-print" onClick={()=>loadRecord(r)}><span className="record-icon"><ClipboardPaste size={22}/></span><span><b>{r.branch}</b><small>ترحيلات: {p.transfers.map((t:any)=>t.number).join('، ')}</small><small>فواتير: {p.invoices.map((i:any)=>i.number).join('، ')}</small></span><span>{money(p.summary?.total??null)} د.أ</span><Badge state={r.status} label={p.summary?.acceptedDifference?'مطابق باعتمادك':undefined}/><span className="text-button">فتح المجموعة ←</span></button>})}{!records.length&&<div className="panel empty">لا توجد مجموعات محفوظة بعد.</div>}<InvoiceRegisterPrint records={historyRecords}/></>}
{tab==='invoices'&&<InvoiceRegister records={records} busy={busy} refresh={()=>run(getRecords)} open={loadRecord}/>}
{tab==='monthly'&&<><div className="page-title"><div><p className="eyebrow">إقفال الشهر</p><h1>مطابقة ترحيلات M2026</h1><p>ألصق ترحيلات سلسلة المؤسسة من SAP للشهر المحدد وقارنها مع سجل الموقع.</p></div><button className="button secondary" onClick={()=>run(getRecords)}><RefreshCw size={16}/>تحديث المحفوظ</button></div><section className="panel"><div className="section-title"><CalendarDays size={21}/><h2>كشف الترحيلات الشهري</h2></div><div className="form-grid"><label>الشهر<input type="month" value={month} onChange={e=>{M(e.target.value);FILTERED(false);MR(false)}}/></label><label>تنسيق التاريخ في الكشف<select value={dateFormat} onChange={e=>DF(e.target.value)}><option value="dmy">يوم / شهر / سنة</option><option value="mdy">شهر / يوم / سنة</option></select></label></div><label>ألصق أرقام M2026 (رقم بكل سطر) أو جدول SAP مع العناوين<textarea className="serial-input" dir="ltr" value={serial} onChange={e=>setSerial(e.target.value)} placeholder={'Document Number\tDocument Date\tBranch\n2615835\t02/11/2026\tعوجان'}/></label>{serial&&!numbersOnly&&<div className="form-grid">{(['number','date','branch'] as const).map(k=><label key={k}>{k==='number'?'عمود رقم الترحيل':k==='date'?'عمود التاريخ':'عمود الفرع (اختياري)'}<select value={columns[k]} onChange={e=>COLS({...columns,[k]:Number(e.target.value)})}><option value={-1}>غير محدد</option>{heads.map((h,i)=><option key={i} value={i}>{h||'عمود '+(i+1)}</option>)}</select></label>)}</div>}<label className="check-label"><input type="checkbox" checked={filtered} onChange={e=>FILTERED(e.target.checked)}/>الكشف مفلتر من أول الشهر المحدد إلى آخره (مطلوب إذا لم يوجد عمود تاريخ)</label><button className="button primary" disabled={busy||!serial.trim()} onClick={()=>run(async()=>{await getRecords();MR(true)})}><Search size={17}/>مطابقة كشف الشهر</button></section>{monthReady&&<>{monthResult.problems.length>0&&<div className="banner error"><div><b>نتيجة غير مكتملة؛ راجع التالي:</b>{monthResult.problems.map((p,i)=><p key={i}>{p}</p>)}</div></div>}<div className="monthly-stats">{[['missing','غير مسجلة هنا',monthResult.missing.length],['pending','فواتير غير مكتملة',monthResult.pending.length],['received','فواتير مسجلة',monthResult.received.length],['extra','محفوظة خارج الكشف',monthResult.extra.length],['canceled','ملغاة على SAP',monthResult.canceled.length],['toCancel','كاش فان — مطلوب إلغاؤها',monthResult.toCancel.length],['reverse','ترحيلات عكسية',monthResult.reverse.length]].map(([key,label,n])=><button key={key} className={'stat '+(monthTab===key?'selected':'')} onClick={()=>MT(String(key))}><span>{label}</span><strong>{n}</strong></button>)}</div><section className="panel"><h2>{monthTab==='missing'?'ترحيلات في الكشف لم تُسجّل فواتيرها هنا':monthTab==='pending'?'مجموعات محفوظة وفواتيرها غير مكتملة':monthTab==='received'?'ترحيلات لها فواتير مسجلة':monthTab==='canceled'?'الترحيلات الملغاة وحركات إلغائها':monthTab==='toCancel'?'ترحيلات الكاش فان المطلوب مراجعتها وإلغاؤها على SAP':monthTab==='reverse'?'ترحيلات عكسية خارجة من المؤسسة':'ترحيلات محفوظة للشهر لا تظهر في الكشف'}</h2><div className="table-scroll"><table><thead><tr><th>رقم الترحيل</th><th>التاريخ</th><th>الفرع</th><th>الملاحظة</th><th/></tr></thead><tbody>{(monthResult[monthTab as 'missing'|'pending'|'received'|'extra'|'canceled'|'toCancel'|'reverse'] as any[]||[]).map((r:any)=><tr key={r.number}><td><code>{r.number}</code></td><td>{r.date}</td><td>{r.branch||r.group?.branch||'—'}</td><td>{r.reason||'—'}</td><td>{r.group&&<button className="button secondary small" onClick={()=>loadRecord(r.group)}>فتح المجموعة</button>}</td></tr>)}</tbody></table>{!(monthResult[monthTab as 'missing'] as any[]||[]).length&&<div className="empty">لا توجد ترحيلات بهذه الفئة.</div>}</div><p className="hint">وجود فواتير مسجلة لا يعني تطابق كمياتها؛ افتح المجموعة لعرض نتيجتها. «غير مسجلة» تعني غيابها عن سجل هذا الموقع.</p>{monthResult.duplicates.length>0&&<p className="amber">أرقام مكررة في الكشف حُسبت مرة واحدة: {monthResult.duplicates.join('، ')}</p>}{monthResult.outside.length>0&&<p className="hint">استُبعد {monthResult.outside.length} سطرًا بتاريخ خارج الشهر المحدد.</p>}</section></>}</>}
{tab==='reference'&&<><div className="page-title"><div><p className="eyebrow">قائمة المؤسسة المعتمدة</p><h1>الأصناف والأسعار والشدّات</h1><p>{reference.filter(r=>r.active).length} صنفًا مفعّلًا. رقم المؤسسة لا يتغير بتغيّر تسمية SAP.</p></div><button className="button primary" onClick={()=>EDIT({code:'',sapCode:'',name:'',price:null,invoicePack:null,cartonPieces:null,sapUnit:'Piece',warehouseUnit:null,kgPerPiece:null,active:true})}><Plus size={16}/>إضافة صنف</button></div><div className="banner info">الأسعار والتسميات من نموذج المؤسسة؛ شدّات SAP من ملف المستودع. FVL00311 شدّته 8 حبات. الأصناف غير المربوطة تحتاج تعريفًا صريحًا ولا تُربط بتشابه الاسم.</div><div className="search panel"><Search size={17}/><input value={query} onChange={e=>Q(e.target.value)} placeholder="ابحث برقم المؤسسة أو كود SAP أو الاسم"/></div><section className="panel table-scroll"><table><thead><tr><th>رقم المؤسسة</th><th>رقم SAP</th><th>تسمية المؤسسة</th><th>سعر الحبة</th><th>حبات كرتونة SAP</th><th>وحدة المرجع / المستودع</th><th>وزن الحبة KG</th><th>الحالة</th><th/></tr></thead><tbody>{reference.filter(r=>(r.name+' '+r.code+' '+r.sapCode).toLowerCase().includes(query.toLowerCase())).map(r=><tr key={r.code}><td><code>{r.code}</code></td><td><code>{r.sapCode}</code></td><td className="name-cell">{r.name}</td><td>{money(r.price)}</td><td>{r.cartonPieces??'غير محدد'}</td><td>{r.sapUnit} / {r.warehouseUnit||'غير موجود'}</td><td>{r.kgPerPiece??'غير محدد'}</td><td>{r.active?'مفعّل':'موقوف'}</td><td><button className="button secondary small" onClick={()=>EDIT({...r})}>تعديل</button></td></tr>)}</tbody></table></section></>}
</>}<footer>مركز الكيلاني للأغذية <span>·</span> مطابقة المؤسسة</footer></main></div>{edit&&<div className="modal-backdrop"><section className="modal panel"><div className="section-title"><Settings2 size={21}/><h2>{linkSap?'ربط صنف SAP بالمؤسسة':'تعريف صنف المؤسسة'}</h2><button className="icon-button" disabled={busy} onClick={closeEdit}>×</button></div>{error&&<div className="banner error">{error}</div>}<p className="hint">{reusableLink?'هذا الصنف مربوط في المرجع الحالي. اضغط لتطبيق ربطه على الكشف المفتوح.':linkSap?'أدخل رقم المادة بالمؤسسة. إذا كان الرقم موجودًا، يُضاف كود SAP لهذا الصنف وتحدد شدّة الكود الجديد حسب الحاجة.':'التعديل يؤثر على المطابقات المفتوحة والجديدة. تحتفظ السجلات بأسعار المرجع وقت الحفظ.'}</p>{reusableLink?<p>الربط المعتمد: <b>{reusableLink.code} · {reusableLink.name}</b></p>:<><div className="two-fields"><label>رقم المادة بالمؤسسة<input dir="ltr" value={edit.code} disabled={linkSap?sapReferences(reference).some(r=>r.sapCode===linkSap):reference.some(r=>r.code===edit.code)} onChange={e=>EDIT({...edit,code:e.target.value})}/></label><label>كود SAP<input dir="ltr" value={edit.sapCode} disabled={Boolean(linkSap)} onChange={e=>EDIT({...edit,sapCode:e.target.value.toUpperCase()})}/></label></div>{aliasTarget?<p>ربط بكود إضافي للصنف <b>{aliasTarget.name}</b> ({aliasTarget.code}). سيُستخدم سعر الحبة المسجل للصنف.</p>:<label>تسمية المؤسسة<input value={edit.name} onChange={e=>EDIT({...edit,name:e.target.value})}/></label>}{!linkSap&&Boolean(edit.sapAliases?.length)&&<p>أكواد SAP الإضافية: {edit.sapAliases?.map(alias=>alias.sapCode).join('، ')}</p>}<div className="two-fields">{!aliasTarget&&<label>سعر الحبة بالدينار<input type="number" step="0.001" min="0" value={edit.price===null?'':edit.price/1000} onChange={e=>EDIT({...edit,price:e.target.value===''?null:Math.round(Number(e.target.value)*1000)})}/></label>}<label>حبات كرتونة SAP<input type="number" min="1" value={edit.cartonPieces??''} onChange={e=>EDIT({...edit,cartonPieces:e.target.value===''?null:Number(e.target.value)})}/></label><label>وحدة SAP في المرجع<select value={edit.sapUnit} onChange={e=>EDIT({...edit,sapUnit:e.target.value})}><option>Piece</option><option>Carton</option><option>KG</option></select></label><label>وزن الحبة بالكغم (لتحويل KG)<input type="number" step="any" min="0.000001" value={edit.kgPerPiece??''} onChange={e=>EDIT({...edit,kgPerPiece:e.target.value===''?null:Number(e.target.value)})}/></label></div><label className="check-label"><input type="checkbox" checked={edit.active} disabled={Boolean(linkSap)} onChange={e=>EDIT({...edit,active:e.target.checked})}/>الصنف ضمن قائمة المؤسسة المفعّلة</label></>}<button className="button primary" disabled={busy} onClick={saveItem}><Save size={16}/>{linkSap?'حفظ الربط':'حفظ التعريف'}</button></section></div>}</div>}
