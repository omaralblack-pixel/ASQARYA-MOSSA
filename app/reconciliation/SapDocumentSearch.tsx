'use client';

import {useState} from 'react';
import {AlertTriangle, Search} from 'lucide-react';
import {digits, invoiceDocumentNo, readReconciliationRecord, transferNumbers, withInvoiceDates, markSearchedPaperInvoice, type Draft} from '../lib/reconcile';
import {groupSapEvidence, searchArchivedSapEvidence, type SapEvidence} from '../lib/sap-document-lookup';
import type {SapImportGroup} from '../lib/sap-import';

type DocumentKind = 'invoice' | 'transfer';
type Filter = DocumentKind | 'all';
type RecordRow = {id:string;branch:string;version:number;payload:string};
type SearchHit = {kind:DocumentKind;number:string;branch:string;origin:'saved'|'sap';recordId?:string};
type LookupResponse = {hits:SapEvidence[];partial:boolean;snapshotKey?:string|null};
type Props = {
  branches:string[];
  onOpenSaved:(id:string,invoiceNumber?:string)=>void;
  onOpenDraft:(draft:Draft,group:SapImportGroup,reviewNotes:string[])=>void;
};

async function readJson<T>(url:string):Promise<T> {
  const response=await fetch(url,{cache:'no-store'});
  const type=response.headers.get('content-type')||'';
  if(!type.includes('application/json'))throw Error('تعذّر قراءة استجابة الخادم. لم تتغيّر بيانات المطابقة.');
  const data=await response.json() as T & {error?:string};
  if(!response.ok)throw Error(data.error||'تعذّر البحث في السجلات.');
  return data;
}

function documentHits(records:RecordRow[],sap:SapEvidence[],query:string,filter:Filter):SearchHit[] {
  const matches=new Map<string,SearchHit>();
  const add=(kind:DocumentKind,raw:unknown,branch:string,origin:'saved'|'sap',recordId?:string)=>{
    if(filter!=='all'&&filter!==kind)return;
    const number=kind==='invoice'?invoiceDocumentNo(raw):digits(String(raw??'')).trim();
    if(!/^\d{4,20}$/.test(number)||!number.endsWith(query))return;
    // Keep each stored owner visible if historical data contain duplicates;
    // never silently choose one of two records with the same invoice number.
    const key=kind+':'+number+(origin==='saved'?':'+recordId:'');
    if(origin==='saved')matches.delete(kind+':'+number);
    if(origin==='sap'&&[...matches.values()].some(hit=>hit.kind===kind&&hit.number===number&&hit.origin==='saved'))return;
    if(!matches.has(key))matches.set(key,{kind,number,branch,origin,recordId});
  };
  for(const row of records){
    const saved=readReconciliationRecord(row.payload);
    if(!saved)continue;
    for(const invoice of saved.invoices||[])add('invoice',invoice.number,row.branch,'saved',row.id);
    for(const transfer of saved.transfers||[])
      for(const number of transferNumbers(transfer.number))add('transfer',number,row.branch,'saved',row.id);
  }
  for(const item of sap){
    for(const number of item.invoiceNumbers)add('invoice',number,item.branch,'sap');
    add('transfer',item.transfer.number,item.branch,'sap');
  }
  return [...matches.values()].sort((a,b)=>{
    const aExact=a.number===query?0:1,bExact=b.number===query?0:1;
    return aExact-bExact||a.kind.localeCompare(b.kind)||a.number.localeCompare(b.number,'en',{numeric:true});
  });
}

function draftForReview(group:SapImportGroup,invoiceNumber?:string):Draft {
  const makeId=()=>crypto.randomUUID();
  return markSearchedPaperInvoice(withInvoiceDates({
    mode:'manual',branch:group.draft.branch,driver:'',date:group.draft.date,notes:'',checks:{},
    transfers:group.draft.transfers.map(item=>({...item,id:makeId()})),
    invoices:group.draft.invoices.map(item=>({
      ...item,id:makeId(),manualNumber:!!invoiceDocumentNo(item.number),
      amount:'',complete:false,quantities:{},attachments:[]
    }))
  }),invoiceNumber||'');
}

function reviewNotes(group:SapImportGroup,source:SapEvidence[]):string[] {
  const notes:string[]=[];
  for(const member of group.members){
    const number=member.transfer.number;
    const original=source.find(item=>item.transfer.number===number);
    if(member.reverseMovement)notes.push('الترحيل '+number+': حركة عكسية صادرة من 011؛ هذا وحده لا يثبت إلغاء الترحيل.');
    else if(member.reversal)notes.push('الترحيل '+number+': توجد إشارة إلغاء أو تصحيح أو كمية سالبة؛ تحقق من مستند SAP الأصلي.');
    if(original&&['canceled','cancellation'].includes(original.cancellationState))
      notes.push('الترحيل '+number+': حالة الإلغاء واردة في بيانات SAP؛ تحقق من المستند المقابل.');
    for(const issue of member.issues)notes.push('الترحيل '+number+': '+issue);
  }
  return [...new Set([...notes,...group.issues])];
}

/** Search only. No SAP uploads, writes, or automatic approval. */
export default function SapDocumentSearch({branches,onOpenSaved,onOpenDraft}:Props){
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState<Filter>('all');
  const [matches,setMatches]=useState<SearchHit[]>([]);
  const [records,setRecords]=useState<RecordRow[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [warning,setWarning]=useState('');
  const [searched,setSearched]=useState(false);

  async function search(){
    const number=digits(query).trim();
    setError('');setWarning('');setSearched(false);setMatches([]);
    if(!/^\d{4,20}$/.test(number)){setError('أدخل رقم فاتورة زرقاء أو رقم ترحيل (4 أرقام على الأقل).');return;}
    setBusy(true);
    try{
      const [savedResponse,sapResponse]=await Promise.all([
        readJson<{records:RecordRow[]}>('/api/reconcile?records=1'),
        readJson<LookupResponse>('/api/reconcile?sapLookup='+encodeURIComponent(number))
      ]);
      const saved=Array.isArray(savedResponse.records)?savedResponse.records:[];
      let sap=Array.isArray(sapResponse.hits)?sapResponse.hits:[];
      const foundInSaved=documentHits(saved,[],number,filter).length>0;
      if(!sap.length&&!foundInSaved&&number.length>=6){
        const archived=await searchArchivedSapEvidence(number,filter==='all'?(number.length>=9?'invoice':'transfer'):filter,branches);
        sap=archived.hits;
        if(archived.unreadable)
          setWarning('تعذّر قراءة '+archived.unreadable+' ملف SAP مؤرشف. نتيجة البحث قد تكون ناقصة، ولا يعني ذلك إلغاء المستند.');
      }
      setRecords(saved);
      setMatches(documentHits(saved,sap,number,filter));
      setSearched(true);
      if(sapResponse.partial)setWarning(previous=>previous+' نتائج أرشيف SAP المستورد محدودة بأول 400 مستند؛ أكمل البحث بالرقم الكامل.');
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر البحث عن المستند.');}
    finally{setBusy(false);}
  }

  async function openHit(hit:SearchHit){
    setError('');
    if(hit.recordId){onOpenSaved(hit.recordId,hit.kind==='invoice'?hit.number:undefined);return;}
    setBusy(true);
    try{
      // Search again by the full selected document number to include every
      // associated SAP transfer, rather than only the last-four-digit preview.
      const response=await readJson<LookupResponse>('/api/reconcile?sapLookup='+encodeURIComponent(hit.number));
      let sap=response.hits||[];
      let group=groupSapEvidence(sap,hit.number,hit.kind,branches);
      if(!group){
        const archived=await searchArchivedSapEvidence(hit.number,hit.kind,branches);
        sap=archived.hits;
        group=groupSapEvidence(sap,hit.number,hit.kind,branches);
        if(archived.unreadable>0)setWarning('بعض أصول SAP غير مقروءة. لا تعتمد اكتمال المستند قبل مراجعتها.');
      }
      if(!group)throw Error('لم تظهر تفاصيل هذا الرقم في بيانات SAP القابلة للقراءة. لا تعتبره ملغى أو غير موجود.');
      const transferNos=new Set(group.members.map(item=>item.transfer.number));
      const owners=records.filter(row=>{
        const saved=readReconciliationRecord(row.payload);
        return !!saved?.transfers.some(item=>transferNumbers(item.number).some(no=>transferNos.has(no)));
      });
      if(owners.length){
        if(owners.length===1){
          onOpenSaved(owners[0].id,hit.kind==='invoice'?hit.number:undefined);
          setWarning('هذا الترحيل مسجل بالفعل في المطابقة. فُتح سجله الأصلي بدل إنشاء نسخة مكررة. راجع الربط والفواتير داخله.');
          return;
        }
        throw Error('الترحيلات المطلوبة موزعة على '+owners.length+' سجلات محفوظة. افتح كل سجل من نتائج البحث وراجع الربط قبل الدمج، منعًا لتكرار الترحيلات.');
      }
      onOpenDraft(draftForReview(group,hit.kind==='invoice'?hit.number:undefined),group,reviewNotes(group,sap));
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر فتح المستند للمراجعة.');}
    finally{setBusy(false);}
  }

  return <section className="panel no-print" aria-label="البحث عن الفاتورة الزرقاء أو ترحيل SAP">
    <div className="section-title">
      <Search size={19}/>
      <div><h2>ابحث برقم الفاتورة الزرقاء أو رقم الترحيل</h2>
        <p>من سجل المطابقات وملفات SAP المحفوظة، بدون استيراد الملف مرة أخرى.</p></div>
    </div>
    <form onSubmit={event=>{event.preventDefault();void search();}}>
      <div className="table-controls">
        <div className="search">
          <Search size={16}/>
          <input type="search" dir="ltr" inputMode="numeric" value={query}
            onChange={event=>setQuery(event.target.value)} aria-label="رقم الفاتورة الزرقاء أو الترحيل"
            placeholder="رقم الفاتورة الزرقاء أو الترحيل، أو آخر 4 أرقام"/>
        </div>
        <select aria-label="نوع رقم البحث" value={filter}
          onChange={event=>setFilter(event.target.value as Filter)}>
          <option value="all">الفواتير والترحيلات</option>
          <option value="invoice">الفواتير الزرقاء فقط</option>
          <option value="transfer">ترحيلات SAP فقط</option>
        </select>
        <button type="submit" className="button primary" disabled={busy}>
          <Search size={16}/>{busy?'جاري البحث…':'بحث وسحب المستند'}
        </button>
      </div>
    </form>
    {error&&<div className="banner error" role="alert">{error}</div>}
    {warning&&<div className="banner info" role="status"><AlertTriangle size={16}/>{warning}</div>}
    {searched&&<div className="sap-document-results" aria-live="polite">
      {matches.length
        ?<><p className="hint">اختر المستند لفتحه في المطابقة الأساسية. لا يُعتمد ولا يُحفظ تلقائيًا.</p>
          <div className="cards-grid">{matches.slice(0,40).map(hit=>
            <button type="button" key={hit.kind+':'+hit.number+':'+(hit.recordId||hit.origin)} className="button secondary"
              disabled={busy} onClick={()=>{void openHit(hit);}}>
              <span dir="ltr">{hit.number}</span>
              <span>{hit.kind==='invoice'?'فاتورة زرقاء':'ترحيل SAP'}</span>
              <span>{hit.origin==='saved'?'محفوظ':'من SAP'}</span>
              {hit.branch&&<small>{hit.branch}</small>}
            </button>)}</div>
          {matches.length>40&&<p className="hint">ظهرت نتائج إضافية؛ اكتب الرقم كاملًا لتحديد المستند المطلوب.</p>}</>
        :<p className="hint">لم يظهر الرقم في البيانات المحفوظة أو المقروءة حاليًا؛ هذا لا يعني أن المستند ملغى أو غير موجود في SAP. تحقق من الرقم أو مصدر الملف.</p>}
    </div>}
  </section>;
}
