'use client';
import {boundedFetch,readJson as getJson} from '../lib/bounded-read';

import {useEffect, useMemo, useRef, useState} from 'react';
import {CheckCircle2, AlertTriangle, Plus, Search, Save, ArrowLeft, RefreshCw, Trash2} from 'lucide-react';
import GroupLookup from './GroupLookup';
import {isAqabaBranch} from '../lib/aqaba-instant-reference';
import {readCurrentSapImport} from '../lib/approved-sap-client';
import {parseSapImport,sapBranchFromRemarks,type SapImportGroup} from '../lib/sap-import';
import {groupSapEvidence,searchArchivedSapEvidence,type SapEvidence} from '../lib/sap-document-lookup';
import {prepareReconciliation, readReconciliationRecord, parseTransfer, withInvoiceDates, editGroupInvoiceDate, addTransferToDraft, withSapInvoiceNumbers, transferNumbers, invoiceDocumentNo, matchesInvoiceNumbers, digits, fils, money, dateValue, type Draft, type Invoice, type Item, type Transfer, type TransferSource} from '../lib/reconcile';

type Summary = {id:string; branch:string; version:number; payload:string};
type SavedTransfer = {transfer:Transfer; invoiceNumbers:string[]; recordId:string; version:number; branch:string};
type SearchKind = 'invoice' | 'transfer';
type SearchFilter = SearchKind | 'all';
type DocumentHit = {kind:SearchKind; number:string; branch:string; origin:'saved'|'sap'};
type ReverseChoice = {group:SapImportGroup;number:string;kind:SearchKind;mode:'lookup'|'append';notes:string[];blockers:string[]};

const localDate = () => new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Amman'});
const uuid = () => crypto.randomUUID();
const invoice = (number = ''):Invoice => ({
  id:uuid(), number, date:'', amount:'', manualNumber:!!number,
  complete:true, quantities:{}, attachments:[]
});
const fresh = (number = ''):Draft => ({
  mode:'manual', branch:'', driver:'', date:localDate(), notes:'',
  transfers:[], invoices:[invoice(number)], checks:{}
});

async function saveJson(draft:Draft, sources:TransferSource[]) {
  const response = await boundedFetch('/api/reconcile', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'save', draft, transferSources:sources})
  });
  const data = await response.json() as {error?:string};
  if (!response.ok) throw Error(data.error || 'تعذّر الحفظ');
  return data as {id:string;version:number;referenceSnapshot:Item[];summary:{status:string}};
}
function recordDraft(row:Summary):Partial<Draft> {
  return readReconciliationRecord(row.payload)||{};
}
function matchesRecord(row:Summary, number:string, kind:SearchKind) {
  const saved = recordDraft(row);
  return kind==='invoice'
    ? (saved.invoices || []).some(item=>invoiceDocumentNo(item.number)===number)
    : (saved.transfers || []).some(item=>transferNumbers(item.number).includes(number));
}
function matchingDocuments(rows:Summary[], groups:SapImportGroup[], query:string, filter:SearchFilter, extra:SapEvidence[]=[]):DocumentHit[] {
  const searched = digits(query).trim();
  if (!/^\d{4,20}$/.test(searched)) return [];
  const matches = new Map<string,DocumentHit>();
  const add = (raw:unknown, kind:SearchKind, branch:string, origin:'saved'|'sap') => {
    if (filter!=='all' && filter!==kind) return;
    const value = kind==='invoice' ? invoiceDocumentNo(raw) : digits(String(raw??'')).trim();
    if (!/^\d{4,20}$/.test(value) || !value.endsWith(searched)) return;
    const key = kind+':'+value;
    if (!matches.has(key) || origin==='saved') matches.set(key,{kind,number:value,branch,origin});
  };
  for (const row of rows) {
    const stored = recordDraft(row);
    for (const item of stored.invoices||[]) add(item.number,'invoice',row.branch,'saved');
    for (const item of stored.transfers||[])
      for (const number of transferNumbers(item.number)) add(number,'transfer',row.branch,'saved');
  }
  for (const group of groups)
    for (const member of group.members) {
      for (const number of member.invoices) add(number,'invoice',member.branch||group.draft.branch,'sap');
      add(member.transfer.number,'transfer',member.branch||group.draft.branch,'sap');
    }
  for(const item of extra){
    for(const invoice of item.invoiceNumbers)add(invoice,'invoice',item.branch,'sap');
    add(item.transfer.number,'transfer',item.branch,'sap');
  }
  return [...matches.values()].sort((a,b)=>
    (a.number===searched?-1:0)-(b.number===searched?-1:0) ||
    a.kind.localeCompare(b.kind) ||
    b.number.localeCompare(a.number,'en',{numeric:true}));
}

// Missing SAP metadata is not proof that a document was canceled. Explain
// the exact affected transfer and keep automatic approval blocked.
function sapMemberReviewReasons(member:SapImportGroup['members'][number]):string[]{
  const number=member.transfer.number;
  return [
    ...(member.reversal&&!member.reverseMovement?['مؤشر إلغاء أو تصحيح أو كمية سالبة؛ يلزم التحقق من حالة المستند في SAP']:[]),
    ...(member.reverseMovement?['حركة عكسية صادرة من المستودع 011؛ هذا لا يعني أن الترحيل ملغى']:[]),
    ...member.issues
  ].map(reason=>'الترحيل '+number+': '+reason);
}

function fromSap(group:SapImportGroup, number:string, kind:SearchKind):Draft {
  const imported = group.draft;
  const originals = imported.invoices.filter(item=>invoiceDocumentNo(item.number));
  const invoices = originals.map(item=>invoice(item.number));
  if (kind==='invoice' && !invoices.some(item=>item.number===number)) invoices.push(invoice(number));
  if (!invoices.length) invoices.push(invoice());
  return withInvoiceDates({
    mode:'manual', branch:imported.branch, driver:'', date:dateValue(imported.date)||localDate(),
    transfers: imported.transfers.map(item=>({...item, id:uuid()})),
    invoices, notes:'', checks:{}
  });
}

export default function InstantMatch({
  reference, branches, onDetailed, syncVersion=0
}:{
  reference:Item[];
  branches:string[];
  syncVersion?:number;
  onDetailed:(draft:Draft, sources:Record<string,TransferSource>)=>void;
}) {
  const searchStart = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const hasCommittedSnapshot=useRef(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [records, setRecords] = useState<Summary[]>([]);
  const [imports, setImports] = useState<SapImportGroup[]>([]);
  const [queueMatches,setQueueMatches]=useState<SapEvidence[]>([]);
  const [suggestionStatus,setSuggestionStatus]=useState<'idle'|'loading'|'error'>('idle');
  const [fileWarning, setFileWarning] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<SearchFilter>('all');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [initialAmount, setInitialAmount] = useState('');
  const [transferNumber, setTransferNumber] = useState('');
  const [draft, setDraft] = useState<Draft|null>(null);
  const [sources, setSources] = useState<Record<string,TransferSource>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showItems, setShowItems] = useState(false);
  const [reverseChoice,setReverseChoice] = useState<ReverseChoice|null>(null);
  const [verifiedReverse,setVerifiedReverse] = useState<string[]>([]);
  const [aqabaPricing,setAqabaPricing] = useState<{reference:Item[];priceCount:number}|null>(null);
  const [aqabaPricingError,setAqabaPricingError] = useState('');
  const [aqabaPricingLoading,setAqabaPricingLoading] = useState(false);
  const isAqaba=!!draft&&isAqabaBranch(draft.branch);

  // Wait for the saved draft to leave the DOM before restoring the search position.
  useEffect(()=>{
    if (!searchFocusRequest) return;
    searchStart.current?.scrollIntoView({behavior:'instant',block:'start'});
    searchInput.current?.focus({preventScroll:true});
  },[searchFocusRequest]);

  const suggestions=useMemo(()=>matchingDocuments(records,hasCommittedSnapshot.current?[]:imports,number,kind,queueMatches),[records,imports,number,kind,queueMatches]);

  async function searchImportedSap(number:string){
    const data=await getJson<{hits:SapEvidence[];partial:boolean;snapshotKey?:string|null}>('/api/reconcile?sapLookup='+encodeURIComponent(number));
    hasCommittedSnapshot.current=!!data.snapshotKey;
    if(data.partial)throw Error('نتائج الترحيلات المستوردة كثيرة وغير مكتملة. ابحث برقم المستند كاملًا.');
    // A previously imported queue may have an empty branch even when
    // the original SAP Remarks names exactly one official branch.
    return data.hits.map(hit=>({...hit,
      branch:hit.branch||sapBranchFromRemarks(hit.remarks,branches)}));
  }

  // Suggestion lookup is debounced and read-only; D1 queue is consulted even
  // when current.json does not contain the requested transfer/invoice.
  useEffect(()=>{
    const searched=digits(number).trim();
    if(!/^\d{4,20}$/.test(searched)){setSuggestionStatus('idle');return}
    let active=true;
    setSuggestionStatus('loading');
    const timer=setTimeout(()=>{
      searchImportedSap(searched).then(hits=>{
        if(active){setQueueMatches(hits);setSuggestionStatus('idle')}
      }).catch(()=>{if(active)setSuggestionStatus('error')});
    },350);
    return ()=>{active=false;clearTimeout(timer)};
  },[number,branches,syncVersion]);

  async function refreshRecords() {
    const data = await getJson<{records:Summary[]}>('/api/reconcile?records=1');
    const list = data.records as Summary[];
    setRecords(list);
    return list;
  }

  useEffect(()=>{
    if (!branches.length) return;
    let active = true;
    setLoading(true);
    setFileWarning('');
    async function initialize() {
      const results = await Promise.allSettled([
        getJson<{records:Summary[]}>('/api/reconcile?records=1'),
        readCurrentSapImport()
      ]);
      if (!active) return;
      if (results[0].status === 'fulfilled') setRecords(results[0].value.records || []);
      else setFileWarning('تعذّر قراءة سجل المطابقات. ابحث مجددًا بعد تحديث الصفحة.');
      if (results[1].status === 'fulfilled' && results[1].value?.text) {
        const parsed = parseSapImport(results[1].value.text, branches);
        setImports(parsed.groups);
        if (parsed.issues.length) setFileWarning('في ملف SAP سطور تحتاج مراجعة: ' + parsed.issues[0]);
      } else {
        setFileWarning('كشف SAP المحفوظ غير متاح. يمكن البحث بالسجل أو إدخال الترحيل يدويًا، وارفع TXT من شاشة المطابقة الأساسية إذا لزم.');
      }
      setLoading(false);
    }
    void initialize();
    return ()=>{active=false};
  // Refresh search evidence only; keep the operator's open draft and inputs.
  },[branches,syncVersion]);

  useEffect(()=>{
    if(!isAqaba){setAqabaPricing(null);setAqabaPricingError('');setAqabaPricingLoading(false);return}
    let active=true;
    setAqabaPricing(null);setAqabaPricingError('');setAqabaPricingLoading(true);
    getJson<{reference:Item[];priceCount:number}>('/api/reconcile?aqabaPricing=1')
      .then(data=>{if(active){
        if(!Array.isArray(data.reference)||!data.reference.length)throw Error('لا توجد أسعار عقبة معتمدة.');
        setAqabaPricing(data);
      }}).catch(e=>{if(active)setAqabaPricingError(e instanceof Error?e.message:'تعذّر قراءة أسعار العقبة.')})
      .finally(()=>{if(active)setAqabaPricingLoading(false)});
    return ()=>{active=false};
  },[isAqaba]);

  function update(next:Draft) {
    if(draft&&(draft.branch!==next.branch||JSON.stringify(draft.transfers)!==JSON.stringify(next.transfers)))
      setVerifiedReverse([]);
    setDraft(withInvoiceDates(next));
    setNotice('');
  }
  function updateInvoice(id:string, changes:Partial<Invoice>) {
    if (!draft) return;
    update({...draft, invoices:draft.invoices.map(row=>row.id===id?{...row,...changes}:row)});
  }

  function fillSearchedAmount(candidate:Draft, target:string, searchKind:SearchKind):Draft {
    if (searchKind!=='invoice'||!initialAmount.trim()) return candidate;
    return {...candidate,invoices:candidate.invoices.map(item=>invoiceDocumentNo(item.number)===target
      ? {...item,amount:initialAmount}:item)};
  }

  async function loadRecord(record:Summary, target = '', searchKind:SearchKind = 'transfer') {
    const data = await getJson<{record:Summary}>('/api/reconcile?id='+encodeURIComponent(record.id));
    const saved = readReconciliationRecord(data.record.payload);
    if(!saved)throw Error('بيانات هذا الكشف غير مقروءة؛ لم يتم تعديلها.');
    setDraft(withInvoiceDates(fillSearchedAmount({...saved,mode:'manual',id:data.record.id,version:data.record.version,checks:saved.checks||{}},target,searchKind)));
    setSources({});setVerifiedReverse([]);setReverseChoice(null);
    setNotice('تم استرجاع الكشف المحفوظ. تقدر تعدّل الأسعار أو تضيف ترحيل بدون إنشاء سجل مكرر.');
  }

  // Reverse 011 -> 001/002/009 decreases stock in the net quantity.
  // Direction alone is never proof that SAP canceled the transfer.
  function reverseChoiceFor(group:SapImportGroup,number:string,kind:SearchKind,mode:ReverseChoice['mode'],evidence:SapEvidence[]=[]):ReverseChoice{
    const notes=[...new Set([...group.members.flatMap(sapMemberReviewReasons),...group.issues])];
    const blockers=[
      ...group.members.flatMap(member=>member.issues.filter(issue=>!issue.includes('الفرع غير معروف')).map(issue=>'الترحيل '+member.transfer.number+': '+issue)),
      ...group.members.filter(member=>member.reversal&&!member.reverseMovement).map(member=>'الترحيل '+member.transfer.number+': إشارة إلغاء أو تصحيح مستقلة عن اتجاه 011.'),
      ...group.members.filter(member=>!!member.canceledTransferNo||/has been cancel(?:ed|led)|ملغى/.test(member.remarks)).map(member=>'الترحيل '+member.transfer.number+': دليل إلغاء في ملاحظات SAP.'),
      ...evidence.filter(item=>group.members.some(member=>member.transfer.number===item.transfer.number)
        &&['canceled','cancellation'].includes(item.cancellationState)).map(item=>'الترحيل '+item.transfer.number+': مستند SAP معلّم كإلغاء.'),
      ...group.issues.filter(issue=>!issue.startsWith('ترحيل عكسي —')&&!issue.includes('الفرع غير معروف'))
    ];
    return {group,number,kind,mode,notes,blockers:[...new Set(blockers)]};
  }

  async function prepareSapDraft(group:SapImportGroup,searched:string,searchKind:SearchKind){
    const rows=await refreshRecords();
    const proposed=fillSearchedAmount(fromSap(group,searched,searchKind),searched,searchKind);
    const occupied=proposed.transfers.flatMap(item=>rows
      .filter(row=>matchesRecord(row,item.number,'transfer'))
      .map(row=>({row,number:item.number})));
    if(occupied.some(({row})=>(recordDraft(row).invoices||[]).some(inv=>invoiceDocumentNo(inv.number)))){
      throw Error('في ترحيل مرتبط بفاتورة زرقاء محفوظة. افتح الفاتورة من السجل بدل تكرارها.');
    }
    const first=occupied[0];
    if(!first)return {draft:proposed,sources:{} as Record<string,TransferSource>,
      message:'تم جلب ترحيلات SAP دون حفظها. أدخل مبالغ الفواتير وراجع الكميات.'};
    const original=await getJson<{record:Summary}>('/api/reconcile?id='+encodeURIComponent(first.row.id));
    const base=readReconciliationRecord(original.record.payload);
    if(!base)throw Error('بيانات هذا الكشف غير مقروءة؛ لم يتم تعديلها.');
    const other=proposed.transfers.filter(row=>row.number!==first.number);
    const baseTransfer=base.transfers.find(row=>transferNumbers(row.number).includes(first.number));
    if(!baseTransfer||transferNumbers(baseTransfer.number).length!==1)
      throw Error('الترحيل محفوظ مع أرقام أخرى في نفس البطاقة. افتحه من سجل المطابقات أولًا.');
    const nextSources:Record<string,TransferSource>={};
    for(const item of other){
      const owner=occupied.find(entry=>entry.number===item.number);
      if(owner&&owner.row.id!==first.row.id)
        nextSources[item.id]={number:item.number,recordId:owner.row.id,version:owner.row.version};
    }
    return {draft:withInvoiceDates({...proposed,id:original.record.id,version:original.record.version,
      transfers:[{...baseTransfer},...other],branch:proposed.branch||base.branch,
      referenceSnapshot:base.referenceSnapshot,useCurrentReference:true}),
      sources:nextSources,message:'تم فتح سجل ترحيل محفوظ دون فاتورة، دون إنشاء ترحيل مكرر.'};
  }

  async function acceptReverseChoice(openDetailed=false){
    const choice=reverseChoice;
    if(!choice||busy)return;
    if(!openDetailed&&choice.blockers.length){
      setError('هناك ملاحظات SAP أخرى غير اتجاه 011؛ راجعها في المطابقة العادية: '+choice.blockers.join('؛ '));
      return;
    }
    setBusy(true);setError('');
    try{
      if(choice.mode==='append'){
        if(!draft)throw Error('لا يوجد كشف مفتوح لإضافة الحركة العكسية.');
        const member=choice.group.members.find(item=>item.transfer.number===choice.number);
        if(!member)throw Error('تعذّر استرجاع تفاصيل الترحيل العكسي.');
        const latest=await refreshRecords();
        const owner=latest.find(row=>matchesRecord(row,choice.number,'transfer')&&row.id!==draft.id);
        if(owner){
          const data=await getJson<{record:Summary}>('/api/reconcile?id='+encodeURIComponent(owner.id));
          const saved=readReconciliationRecord(data.record.payload);
          if(!saved)throw Error('هذا الترحيل محفوظ لكن بيانات كشفه غير مقروءة.');
          if(openDetailed){
            onDetailed(withInvoiceDates({...saved,id:data.record.id,version:data.record.version,mode:'manual'}),{});
            setReverseChoice(null);
            return;
          }
          throw Error('الترحيل محفوظ في كشف آخر. استخدم «فتح المستند في المطابقة العادية» لفتح أصله، بدل تكراره.');
        }
        if(member.invoices.length&&draft.invoices.some(invoice=>invoiceDocumentNo(invoice.number))
          &&!matchesInvoiceNumbers(draft.invoices,member.invoices))
          throw Error('الفواتير الزرقاء في SAP ('+member.invoices.join('، ')+') لا تطابق فواتير الكشف الحالي.');
        if(draft.transfers.some(item=>transferNumbers(item.number).includes(choice.number)))
          throw Error('الترحيل موجود مسبقًا في الكشف الحالي.');
        if(draft.transfers.length>=30)throw Error('وصلت إلى الحد الأقصى للترحيلات.');
        if(draft.branch&&member.branch&&draft.branch!==member.branch)
          throw Error('الترحيل العكسي تابع لفرع '+member.branch+' وليس فرع الفاتورة الحالية.');
        const next=withInvoiceDates({...draft,transfers:[...draft.transfers,{...member.transfer,id:uuid()}]});
        if(openDetailed)onDetailed(next,sources);
        else{
          setDraft(next);
          setNotice('تمت إضافة الحركة العكسية '+choice.number+' بصافي سالب. شيّكها مع مؤسسة الفرع وأكّد مراجعتها قبل الحفظ.');
        }
      }else{
        const prepared=await prepareSapDraft(choice.group,choice.number,choice.kind);
        if(openDetailed)onDetailed(prepared.draft,prepared.sources);
        else{
          setDraft(prepared.draft);setSources(prepared.sources);
          setVerifiedReverse([]);
          setNotice('تمت إضافة الحركة العكسية للمطابقة الفورية بصافي سالب. راجع الفرع والكميات ومبالغ الفواتير، ثم ضع علامة التشييك.');
        }
      }
      setReverseChoice(null);
    }catch(e){setError(e instanceof Error?e.message:'تعذّر فتح الترحيل العكسي.');}
    finally{setBusy(false);}
  }

  async function lookup(query=number, selectedKind:SearchFilter=kind) {
    const searched = digits(query).trim();
    if (!/^\d{4,20}$/.test(searched)) {setError('اكتب رقم فاتورة أو ترحيل صحيحًا.');return}
    const options=matchingDocuments(records,imports,searched,selectedKind);
    const exact=options.some(item=>item.number===searched);
    if (searched.length===4 || (!exact&&options.length>0)) {
      // Suggestions while typing may be stale; consult current D1 records
      // before saying that a document has no matches.
      setBusy(true);
      setError('');
      try {
        const latestRecords = await refreshRecords();
        const queued=await searchImportedSap(searched);
        setQueueMatches(queued);
        const latest = matchingDocuments(latestRecords,imports,searched,selectedKind,queued);
        setSuggestionsOpen(true);
        setError(latest.length
          ?'اختر رقم المستند الكامل من الاقتراحات بعد تحديث السجل.'
          :'لم تظهر أرقام بهذه الخانات في السجل الحالي أو ملف SAP الحالي. هذا لا يعني أن الورق غير واصل. جرّب الرقم كاملًا، أو راجع الأرشيف القديم.');
      } catch(error) {
        setError(error instanceof Error ? error.message : 'تعذّر التحقق من سجل المطابقات المحفوظ.');
      } finally {setBusy(false)}
      return;
    }
    const searchKind:SearchKind=selectedKind==='all'?(searched.length>=9?'invoice':'transfer'):selectedKind;
    if (searchKind==='invoice'&&initialAmount.trim()&&fils(initialAmount)===null) {
      setError('أدخل مبلغ الفاتورة بشكل صحيح، مثل 186.400 دينار.');return;
    }
    setBusy(true);setSuggestionsOpen(false);setError('');setNotice('');setShowItems(false);setReverseChoice(null);setVerifiedReverse([]);
    try {
      const [rows,queued]=await Promise.all([refreshRecords(),searchImportedSap(searched)]);
      setQueueMatches(queued);
      const found = rows.filter(row=>matchesRecord(row,searched,searchKind));
      if (found.length>1) throw Error('رقم المستند مكرر في السجل؛ يلزم مراجعة المطابقة الأساسية.');
      if (found.length===1) { await loadRecord(found[0],searched,searchKind);return; }

      // The committed daily snapshot is authoritative. A browser may still
      // have the previous shared preview while the new snapshot is published.
      let reviewEvidence=queued;
      let candidate = groupSapEvidence(queued,searched,searchKind,branches)||
        (!hasCommittedSnapshot.current?imports.find(group=>group.members.some(member=>
          searchKind==='invoice'?member.invoices.includes(searched):member.transfer.number===searched)):undefined);
      // Imported records may hold old Remarks; only inspect full immutable SAP
      // originals after an explicit user search, never on each keystroke.
      if(!candidate ||
        (searchKind==='transfer'&&candidate.members.every(member=>!member.invoices.length))||
        candidate.members.some(member=>!member.branch&&member.issues.includes('الفرع غير معروف'))||
        candidate.issues.some(issue=>issue.includes('الفرع غير معروف'))){
        let archived;
        try{archived=await searchArchivedSapEvidence(searched,searchKind,branches)}
        catch(e){
          if(!candidate)throw Error('تعذّر فحص أرشيف ملفات SAP: '+(e instanceof Error?e.message:String(e)));
          setFileWarning('تعذّر فحص الملفات المؤرشفة؛ الرابط المعروض من البيانات المستوردة فقط.');
        }
        if(archived){
          const proposal=groupSapEvidence(archived.hits,searched,searchKind,branches);
          // Preserve every known transfer when replacing a stale queued result
          // with the original SAP evidence. Never lose a flagged transfer.
          if(proposal&&(!candidate||candidate.members.every(member=>
            proposal.members.some(original=>original.transfer.number===member.transfer.number)))){
              candidate=proposal;
              reviewEvidence=archived.hits;
            }
          if(archived.unreadable>0){
            setFileWarning('تعذّر قراءة '+archived.unreadable+' ملف SAP مؤرشف؛ النتائج قد تكون ناقصة، ولا يُعتبر غياب الرقم إثباتًا لعدم وجود الفاتورة.');
            if(!candidate)throw Error('الفحص غير مكتمل: لم تُقرأ بعض ملفات SAP المؤرشفة. لا تنشئ فاتورة مكررة قبل مراجعة الأصول.');
          }
        }
      }
      if (candidate) {
        const reviewReasons=[...new Set([...candidate.members.flatMap(sapMemberReviewReasons),...candidate.issues])];
        if(candidate.members.some(member=>member.reverseMovement)){
          const choice=reverseChoiceFor(candidate,searched,searchKind,'lookup',reviewEvidence);
          setReverseChoice(choice);
          setNotice('تم العثور على حركة عكسية من المستودع 011. اختر إضافتها للمطابقة الفورية أو فتح المطابقة العادية؛ اتجاه الحركة لا يثبت إلغاء المستند.');
        }else{
          if(reviewReasons.length)throw Error('لا يمكن اعتماد المستند تلقائيًا: '+reviewReasons.slice(0,4).join('؛ ')+
            (reviewReasons.length>4?'؛ توجد ملاحظات أخرى.':'.')+
            ' افتح المطابقة الأساسية للمراجعة. خطأ القراءة لا يعني أن الترحيل ملغى.');
          const prepared=await prepareSapDraft(candidate,searched,searchKind);
          setDraft(prepared.draft);setSources(prepared.sources);
          setNotice(prepared.message);
        }
      } else if (searchKind==='transfer') {
        const savedResponse = await boundedFetch('/api/reconcile?transfer='+encodeURIComponent(searched),{cache:'no-store'});
        if (savedResponse.ok) {
          const saved = await savedResponse.json() as SavedTransfer;
          const row = rows.find(item=>item.id===saved.recordId);
          if (row) {await loadRecord(row);return}
        } else if (savedResponse.status!==404) {
          throw Error(((await savedResponse.json()) as {error?:string}).error||'تعذّر البحث عن الترحيل.');
        }
        setSources({});
        setDraft({...fresh(),transfers:[{id:uuid(),number:searched,date:localDate(),paste:''}]});
        setNotice('الترحيل غير مثبت في المصادر المحمّلة أو المؤرشفة التي أمكن قراءتها. ألصق جدول SAP الأصلي للتحقق، ولا تعتبره مفقودًا تلقائيًا.');
      } else {
        setSources({});
        setDraft(fillSearchedAmount(fresh(searched),searched,searchKind));
        setNotice('لم أجد دليلًا مباشرًا لهذا الرقم في السجل، أو ترحيلات SAP المستوردة، أو الأصول المؤرشفة القابلة للقراءة. فتحته كفاتورة جديدة غير محفوظة للمراجعة فقط؛ لا تحفظها قبل تأكيد رقم الترحيل لتجنب التكرار.');
      }
    } catch(e) {setError(e instanceof Error?e.message:'تعذّر البحث عن المستند.')}
    finally {setBusy(false);}
  }

  async function addTransfer() {
    if (!draft) return;
    const searched = digits(transferNumber).trim();
    if (!/^\d{4,20}$/.test(searched)) {setError('اكتب رقم ترحيل صحيحًا.');return}
    if (draft.transfers.length>=30) {setError('الحد الأقصى 30 ترحيلًا للمطابقة.');return}
    if (draft.transfers.some(item=>transferNumbers(item.number).includes(searched))) {
      setError('الترحيل موجود أصلًا في الكشف الحالي.');return;
    }
    setBusy(true);setError('');setNotice('');
    try {
      let stored:SavedTransfer|null = null;
      const response=await boundedFetch('/api/reconcile?transfer='+encodeURIComponent(searched),{cache:'no-store'});
      if (response.ok) stored=await response.json() as SavedTransfer;
      else if (response.status!==404) throw Error(((await response.json()) as {error?:string}).error||'تعذّر فحص الترحيل.');
      if (stored && stored.recordId!==draft.id && stored.invoiceNumbers.length) {
        throw Error('الترحيل '+searched+' يحمل فاتورة زرقاء رقم '+stored.invoiceNumbers.join('، ')+'، ولا يمكن إضافته كترحيل ثانٍ.');
      }
      if (stored && stored.recordId===draft.id) throw Error('الترحيل موجود مسبقًا في السجل الحالي.');
      let member = imports.flatMap(group=>group.members).find(item=>item.transfer.number===searched);
      let linked:SapImportGroup|null|undefined;
      let reviewEvidence:SapEvidence[]=[];
      if(!member){
        reviewEvidence=await searchImportedSap(searched);
        linked=groupSapEvidence(reviewEvidence,searched,'transfer',branches);
        if(!linked || linked.members.every(item=>!item.invoices.length)){
          const archived=await searchArchivedSapEvidence(searched,'transfer',branches);
          const found=groupSapEvidence(archived.hits,searched,'transfer',branches);
          if(found){linked=found;reviewEvidence=archived.hits;}
          if(archived.unreadable>0&&!linked)
            throw Error('لم تكتمل قراءة الأصول المؤرشفة للتحقق من رقم الترحيل '+searched+'.');
        }
        member=linked?.members.find(item=>item.transfer.number===searched);
        if(linked?.issues.length&&!member?.reverseMovement)throw Error(linked.issues.join(' · '));
      }
      if(member?.reverseMovement){
        if(!linked)reviewEvidence=await searchImportedSap(searched);
        const linkedGroup=linked||groupSapEvidence(reviewEvidence,searched,'transfer',branches)
          ||imports.find(group=>group.members.some(item=>item.transfer.number===searched));
        if(!linkedGroup)throw Error('تعذّر استرجاع أصل SAP للحركة العكسية.');
        setReverseChoice(reverseChoiceFor(linkedGroup,searched,'transfer','append',reviewEvidence));
        setNotice('الحركة العكسية '+searched+' تحتاج مراجعتك. اختر إضافتها للمطابقة الفورية أو فتح المطابقة العادية.');
        return;
      }
      if(member&&(member.reversal||member.issues.length)){
        throw Error(sapMemberReviewReasons(member).join('؛ ')+'. راجع الترحيل في المطابقة الأساسية قبل إضافته.');
      }
      if (draft.transfers.length>0 && member?.invoices.length && !matchesInvoiceNumbers(draft.invoices,member.invoices)) {
        throw Error('فواتير الترحيل '+searched+' في SAP ('+member.invoices.join('، ')+') لا تطابق فواتير الكشف المفتوح.');
      }
      if (member && draft.branch && member.branch && draft.branch!==member.branch) {
        throw Error('الترحيل تابع لفرع '+member.branch+'، وليس فرع الفاتورة الحالية.');
      }
      if (stored && draft.branch && stored.branch && draft.branch!==stored.branch) {
        throw Error('الترحيل المحفوظ تابع لفرع آخر.');
      }
      if (stored && transferNumbers(stored.transfer.number).length!==1) {
        throw Error('هذا الترحيل محفوظ مع ترحيلات في بطاقة واحدة؛ يجب فصلها أولًا.');
      }
      if (stored && !draft.id && draft.transfers.length===0) {
        const data=await getJson<{record:Summary}>('/api/reconcile?id='+encodeURIComponent(stored.recordId));
        const base=readReconciliationRecord(data.record.payload);
        if(!base)throw Error('بيانات هذا الكشف غير مقروءة؛ لم يتم تعديلها.');
        setDraft(withInvoiceDates({...base,id:stored.recordId,version:stored.version,
          invoices:draft.invoices,branch:draft.branch||stored.branch,mode:'manual',checks:{}}));
        setSources({});
      } else {
        const chosen = stored?.transfer || member?.transfer || {id:uuid(),number:searched,date:localDate(),paste:''};
        const item = {...chosen,id:uuid(),number:searched};
        update(withSapInvoiceNumbers(addTransferToDraft(draft,item,stored?.branch||member?.branch||''),
          !stored&&!member?.reverseMovement?member?.invoices||[]:[],searched));
        if (stored && stored.recordId!==draft.id) {
          setSources(current=>({...current,[item.id]:{number:searched,recordId:stored.recordId,version:stored.version}}));
        }
      }
      setTransferNumber('');
      setNotice(stored||member?'تمت إضافة الترحيل '+searched+' وأصنافه.':'الترحيل غير موجود في TXT؛ ألصق بنوده وتاريخه قبل الحفظ.');
    } catch(e) {setError(e instanceof Error?e.message:'تعذّر إضافة الترحيل.')}
    finally {setBusy(false);}
  }

  const matchingReference=isAqaba?(aqabaPricing?.reference||[]):reference;
  const pricedDraft=isAqaba&&draft?{...draft,useCurrentReference:true,referenceSnapshot:undefined}:draft;
  const prepared=useMemo(()=>pricedDraft?prepareReconciliation(pricedDraft,matchingReference):null,[pricedDraft,matchingReference]);
  const originalResult=prepared?.result??null;
  const result=originalResult;
  const reverseNumbers=useMemo(()=>draft?draft.transfers.filter(transfer=>
    parseTransfer(transfer.paste,{allowReverse:true}).lines.some(line=>line.from==='011'))
    .map(transfer=>transfer.number):[],[draft]);
  const reverseChecked=reverseNumbers.every(number=>verifiedReverse.includes(number));
  const transferWarnings=useMemo(()=>draft ? draft.transfers.flatMap(transfer=>{
    const parsed=parseTransfer(transfer.paste,{allowReverse:true});
    return [...parsed.issues,...parsed.excluded].map(issue=>'الترحيل '+transfer.number+': '+issue);
  }):[],[draft]);
  const canSave=!!draft&&!!result&&(!isAqaba||!!aqabaPricing&&!aqabaPricingLoading&&!aqabaPricingError)
    &&result.status==='match'&&result.priceDifference===0
    &&transferWarnings.length===0&&reverseChecked&&!!draft.branch
    &&draft.transfers.every(item=>item.number&&item.paste.trim()&&dateValue(item.date))
    &&draft.invoices.every(item=>invoiceDocumentNo(item.number)&&fils(item.amount)!==null&&dateValue(item.date));
  async function saveAndNext() {
    if (!prepared||!canSave) return;
    setBusy(true);setError('');
    try {
      const saved=await saveJson(prepared.draft,Object.values(sources));
      await refreshRecords();
      if(saved.summary?.status!=='match'){
        setDraft(current=>current?{...current,id:saved.id,version:saved.version}:current);
        setError('حُفظت الفاتورة، لكن المطابقة الأساسية لم تعتمدها. افتح المطابقة التفصيلية لإكمال الملاحظات.');
        return;
      }
      setDraft(null);setSources({});setNumber('');setInitialAmount('');setTransferNumber('');setShowItems(false);setVerifiedReverse([]);setReverseChoice(null);setSuggestionsOpen(false);
      setNotice('تم حفظ المطابقة في السجل. أدخل رقم الفاتورة التالية.');
      setSearchFocusRequest(current=>current+1);
    } catch(e) {setError(e instanceof Error?e.message:'تعذّر حفظ المطابقة.')}
    finally {setBusy(false);}
  }

  return <div ref={searchStart} className="instant-match" dir="rtl">
    <div className="page-title">
      <div><p className="eyebrow">سير عمل سريع</p><h1>مطابقة فورية</h1>
        <p>اكتب رقم الفاتورة الزرقاء، اسحب ترحيلات SAP، أدخل مبالغ الفواتير، وراجع الفرق مباشرة.</p></div>
      <button type="button" className="button secondary" disabled={busy||loading} onClick={()=>{setDraft(null);setSources({});setNumber('');setInitialAmount('');setTransferNumber('');setReverseChoice(null);setVerifiedReverse([]);setError('');setNotice('');setSuggestionsOpen(false);setSearchFocusRequest(current=>current+1)}}>
        <RefreshCw size={16}/>مطابقة جديدة</button>
    </div>
    <section className="panel">
      <div className="form-grid">
        <label>نوع البحث<select value={kind} onChange={e=>{setKind(e.target.value as SearchFilter);setSuggestionsOpen(true)}}>
          <option value="all">الفواتير الزرقاء والترحيلات معًا</option>
          <option value="invoice">الفواتير الزرقاء فقط</option><option value="transfer">الترحيلات فقط</option>
        </select></label>
        <div className="instant-document-search">
          <label htmlFor="instant-document-number">ابحث برقم الفاتورة الزرقاء أو الترحيل
            <input ref={searchInput} id="instant-document-number" dir="ltr" inputMode="numeric" autoComplete="off"
              value={number} onChange={e=>{setNumber(e.target.value);setQueueMatches([]);setSuggestionsOpen(true);setError('');setReverseChoice(null)}}
              onFocus={()=>setSuggestionsOpen(true)}
              onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void lookup()}}}
              aria-expanded={suggestionsOpen&&/^\d{4,20}$/.test(digits(number).trim())}
              aria-controls="instant-document-results"
              placeholder="اكتب الرقم كاملًا أو آخر 4 أرقام"/>
          </label>
          {suggestionsOpen&&/^\d{4,20}$/.test(digits(number).trim())&&
            <div id="instant-document-results" className="instant-document-results" role="listbox" aria-label="نتائج بحث الفواتير والترحيلات">
              {suggestions.length>0?<><p className="instant-results-heading">{suggestions.length} نتيجة مطابقة — اضغط على الرقم الصحيح</p>
                {suggestions.map(item=><button role="option" aria-selected={false} type="button" disabled={busy||loading}
                  key={item.kind+':'+item.number} onClick={()=>{setNumber(item.number);setSuggestionsOpen(false);void lookup(item.number,item.kind)}}>
                  <strong dir="ltr">{item.number}</strong>
                  <span>{item.kind==='invoice'?'فاتورة زرقاء':'ترحيل SAP'}</span>
                  <small>{item.branch||'الفرع غير معروف'} · {item.origin==='saved'?'محفوظ بالسجل':'ملف SAP'}</small>
                </button>)}</>:
                <p className="instant-results-heading">{suggestionStatus==='loading'?'جارٍ البحث في الترحيلات المستوردة داخل قاعدة البيانات…':
                   suggestionStatus==='error'?'تعذّر البحث التلقائي في الترحيلات المستوردة؛ اضغط «بحث وسحب الترحيلات» لإعادة التحقق.':
                   'لا تظهر اقتراحات بهذا الرقم في البيانات المحمّلة حاليًا. هذا بحث مبدئي، وليس إثباتًا أن الفاتورة غير مسجلة أو أن الورق غير واصل. اضغط «بحث وسحب الترحيلات» للتحقق من السجل المحدث والأرشيف، أو أدخل الرقم كاملًا.'}</p>}
            </div>}
        </div>
        {kind!=='transfer'&&<label>مبلغ الفاتورة الزرقاء (د.أ) — يُستخدم عند اختيار فاتورة
          <input dir="ltr" inputMode="decimal" value={initialAmount} onChange={e=>setInitialAmount(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void lookup()}}} placeholder="186.400"/></label>}
        <div style={{display:'flex',alignItems:'end'}}>
          <button type="button" className="button primary" disabled={busy||loading} onClick={()=>void lookup()}>
            <Search size={16}/>{busy?'جارٍ البحث…':'بحث وسحب الترحيلات'}</button>
        </div>
      </div>
      <p className="hint">اكتب آخر أربع خانات من رقم الفاتورة أو الترحيل لتظهر كل النتائج. اختَر المستند من القائمة؛ لا يجري إنشاء سجل برقم مختصر.</p>
      {loading&&<p className="hint">جارٍ تحميل سجل المطابقات وكشف SAP المحفوظ…</p>}
      {fileWarning&&<p className="hint" role="status">{fileWarning}</p>}
      {error&&<p role="alert" className="banner danger"><AlertTriangle size={16}/> {error}</p>}
      {notice&&<p role="status" className="banner info"><CheckCircle2 size={16}/> {notice}</p>}
      {reverseChoice&&<section className="panel" aria-label="خيارات مراجعة الترحيل العكسي">
        <h3>الترحيل العكسي {reverseChoice.number} — صادر من المستودع 011</h3>
        <p className="hint">الحركة العكسية تنقص صافي مخزون 011، وليست إثباتًا أن المستند ملغى. اختر المطابقة الفورية مع فرع المؤسسة أو المطابقة العادية.</p>
        {reverseChoice.notes.length>0&&<p className="hint">{reverseChoice.notes.join('؛ ')}</p>}
        {reverseChoice.blockers.length>0&&<p className="banner danger" role="alert">هناك مشاكل إضافية في بيانات SAP تمنع الاعتماد الفوري: {reverseChoice.blockers.join('؛ ')}</p>}
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <button type="button" className="button primary" disabled={busy||!!reverseChoice.blockers.length}
            onClick={()=>void acceptReverseChoice(false)}><Plus size={16}/>إضافة الترحيل العكسي للمطابقة الفورية</button>
          <button type="button" className="button secondary" disabled={busy}
            onClick={()=>void acceptReverseChoice(true)}>فتح المستند في المطابقة العادية</button>
        </div>
      </section>}
    </section>

    {draft&&<div style={{display:'grid',gap:16}}>
      <section className="panel">
        <div className="section-title"><h2>بيانات الفواتير والترحيلات</h2></div>
        <div className="form-grid">
          <GroupLookup label="الفرع" items={branches} required value={draft.branch} onChange={branch=>update({...draft,branch})} placeholder="ابحث باسم الفرع أو رقمه"/>
          <label>تاريخ الكشف<input type="date" value={draft.date} onChange={e=>update({...draft,date:e.target.value})}/></label>
        </div>
        {isAqaba&&<div className="banner info" role="status">
          <strong>فرع 84 — العقبة: أسعار العقبة فقط</strong>
          <p>{aqabaPricingLoading?'جاري تحميل الأسعار من سجل فواتير العقبة…':
            aqabaPricingError?'تعذّر تحميل الأسعار: '+aqabaPricingError:
            aqabaPricing?'تم تحميل '+aqabaPricing.priceCount+' سعر صنف من مرجع العقبة. السعر بالدينار للحبة، والحساب بالفلس. لا تستخدم أسعار عمّان.':
            'لا توجد أسعار عقبة متاحة؛ الحفظ معطل حتى تظهر الأسعار.'}</p>
          <p>أي صنف غير معرّف في أسعار العقبة، أو شدّته غير مؤكدة، يظهر كملاحظة ولا يُعتمد بسعر عمّان.</p>
        </div>}
        <h3>الفواتير الزرقاء</h3>
        <p className="hint">التاريخ التلقائي يسبق الترحيل بيوم. تعديل تاريخ أي فاتورة يطبّق التاريخ نفسه على جميع فواتير الكشف.</p>
        <div className="invoice-grid">
          {draft.invoices.map((item,index)=><article className="invoice-card" key={item.id}>
            <div className="card-title"><b>الفاتورة {index+1}</b></div>
            <div className="invoice-fields">
              <label>رقم الفاتورة الزرقاء<input dir="ltr" inputMode="numeric" value={item.number}
                onChange={e=>updateInvoice(item.id,{number:e.target.value,manualNumber:true})}/></label>
              <label>مبلغ الفاتورة (د.أ)<input dir="ltr" inputMode="decimal" value={item.amount}
                onChange={e=>updateInvoice(item.id,{amount:e.target.value})} placeholder="0.000"/></label>
              <label>تاريخ الفاتورة<input type="date" value={item.date}
                onChange={e=>update({...draft,invoices:editGroupInvoiceDate(draft.invoices,e.target.value)})}/></label>
            </div>
            <label className="check-label"><input type="checkbox" checked={item.complete}
              onChange={e=>updateInvoice(item.id,{complete:e.target.checked})}/>الفاتورة الورقية موجودة عندي</label>


            {index>0&&<button className="text-button" type="button"
              onClick={()=>update({...draft,invoices:draft.invoices.filter(row=>row.id!==item.id)})}>حذف الفاتورة</button>}
          </article>)}
        </div>
        <button className="button secondary" type="button" disabled={draft.invoices.length>=30}
          onClick={()=>{
          const groupDate=draft.invoices.find(item=>item.manualDate&&item.date)?.date;
          const next=invoice();
          update({...draft,invoices:[...draft.invoices,groupDate?{...next,date:groupDate,manualDate:true}:next]});
        }}><Plus size={16}/>إضافة فاتورة زرقاء</button>
      </section>
      <section className="panel">
        <div className="section-title"><h2>ترحيلات SAP</h2></div>
        <div className="form-grid">
          <label>أدخل رقم الترحيل لإضافته مباشرة<input dir="ltr" inputMode="numeric" value={transferNumber}
            onChange={e=>{setTransferNumber(e.target.value);setReverseChoice(null)}} onKeyDown={e=>{if(e.key==='Enter')void addTransfer()}}
            placeholder="2615834"/></label>
          <div style={{display:'flex',alignItems:'end'}}><button type="button" className="button secondary"
            disabled={busy} onClick={()=>void addTransfer()}><Plus size={16}/>إضافة الترحيل بالرقم</button></div>
        </div>
        <div className="cards-grid">
          {draft.transfers.map((item,index)=><article className="transfer-card" key={item.id}>
            <div className="card-title"><b>الترحيل {index+1} · {item.number}</b>
              <button type="button" className="icon-button danger" aria-label={'حذف الترحيل '+item.number}
                onClick={()=>{update({...draft,transfers:draft.transfers.filter(t=>t.id!==item.id)});
                  setSources(current=>{const next={...current};delete next[item.id];return next})}}>
                <Trash2 size={15}/></button></div>
            <label>تاريخ الترحيل<input type="date" value={item.date} onChange={e=>update({...draft,
              transfers:draft.transfers.map(row=>row.id===item.id?{...row,date:e.target.value}:row)})}/></label>
            {!item.paste.trim()&&<label>بنود الترحيل من SAP<textarea dir="ltr" rows={5} value={item.paste}
              onChange={e=>update({...draft,transfers:draft.transfers.map(row=>row.id===item.id?{...row,paste:e.target.value}:row)})}
              placeholder={'Item No.\tQuantity\tUoM Name\tFrom Warehouse\tTo Warehouse'}/></label>}
            <small>{item.paste.trim()?'تم جلب بنود الترحيل من SAP':'يلزم لصق بنود SAP قبل المطابقة.'}</small>
          </article>)}
        </div>
        {!draft.transfers.length&&<p className="hint">لا يوجد ترحيل مرتبط بعد. أدخل رقمه في حقل الإضافة.</p>}
      </section>
      {result&&<section className="panel results-panel">
        <div className="section-title"><h2>نتيجة المطابقة الفورية</h2></div>
        <p className="hint">{draft.id?'هذه مجموعة مسترجعة من السجل؛ أي تعديلات حالية لا تُثبت حتى تضغط حفظ.':'هذا كشف قيد الإعداد؛ لم يتم تسجيله في قاعدة البيانات بعد.'}</p>
        {draft.invoices.length>1&&<p className="hint">المطابقة المالية هنا لمجموع الفواتير والترحيلات مجتمعة؛ لا تثبت توزيع الكميات بين الفواتير منفردة. أرقام الصفحات للتشييك الشخصي فقط ولا تؤثر على جندي السيريل أو الاعتماد.</p>}
        <div className="stats">
          <div className="stat"><span>مجموع الفواتير الزرقاء</span><strong>{money(result.total)} د.أ</strong></div>
          <div className="stat"><span>قيمة الترحيلات بأسعار المؤسسة</span><strong>{money(result.expected)} د.أ</strong></div>
          <div className="stat"><span>الفرق (الفواتير − الترحيلات)</span><strong dir="ltr">{money(result.priceDifference)} د.أ</strong></div>
          <div className={'stat status-stat '+result.status}><span>الحالة</span>
            <strong>{result.status==='match'&&result.priceDifference===0&&!transferWarnings.length?(draft.invoices.length>1?'مطابق ماليًا — إجمالي المجموعة':'مطابق ماليًا') :result.status==='difference'||result.priceDifference!==null&&result.priceDifference!==0?'غير مطابق':'بحاجة مراجعة'}</strong></div>
        </div>
        {reverseNumbers.length>0&&<div className="review-list" role="group" aria-label="تشييك الترحيلات العكسية">
          <h3>مراجعة الحركات العكسية من 011 مع المؤسسة</h3>
          <p className="hint">كل حركة عكسية تُخصم من الصافي. تأكد من الفرع والأصناف والكميات مع الورق قبل الاعتماد؛ التشييك لا يغيّر مستند SAP.</p>
          {reverseNumbers.map(number=><label key={number} className="check-label">
            <input type="checkbox" checked={verifiedReverse.includes(number)}
              onChange={event=>setVerifiedReverse(previous=>event.target.checked?[...new Set([...previous,number])]:previous.filter(x=>x!==number))}/>
            شيّكت الحركة العكسية {number} مع مؤسسة الفرع وتأكدت من الكميات
          </label>)}
          {!reverseChecked&&<p className="hint">الحفظ الفوري معطّل إلى أن تُشيّك جميع الحركات العكسية.</p>}
        </div>}
        {draft.invoices.some(item=>!dateValue(item.date))&&<p className="hint" role="alert">حدّد تاريخ الفاتورة الزرقاء أو صحّح التاريخ التلقائي قبل الحفظ، حتى يظل محفوظًا في السجل.</p>}
                {(result.problems.length>0||result.review>0||transferWarnings.length>0)&&<details open className="review-list"><summary>نقاط يجب مراجعتها ({result.problems.length+result.review+transferWarnings.length})</summary>
          {transferWarnings.map((text,index)=><p key={'transfer-'+index}>{text}</p>)}
          {result.problems.map((text,index)=><p key={index}>{text}</p>)}
          {result.rows.filter(row=>row.errors.length).map(row=><p key={row.key}>
            {row.code||row.sapCode} — {row.errors.join('، ')}</p>)}
        </details>}
        {result.status==='difference'&&<p className="hint">في فرق بالقيمة. راجع مبالغ الفواتير، وأصناف الترحيلات، وأسعار المؤسسة قبل الاعتماد.</p>}
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <button type="button" className="button primary" disabled={busy||!canSave} onClick={()=>void saveAndNext()}>
            <Save size={16}/>{busy?'جارٍ الحفظ…':'حفظ المطابقة والانتقال للتالية'} <ArrowLeft size={16}/></button>

          <button type="button" className="button secondary" onClick={()=>setShowItems(!showItems)}>
            {showItems?'إخفاء الأصناف':'عرض تفاصيل الأصناف ('+result.rows.length+')'}</button>
          <button type="button" className="button secondary" onClick={()=>onDetailed(isAqaba&&prepared?{
              ...prepared.draft,referenceSnapshot:prepared.reference,useCurrentReference:false
            }:prepared?.draft??draft,sources)}>
            فتح المطابقة التفصيلية</button>
        </div>
        {showItems&&<div className="table-scroll"><table className="blue-table"><thead><tr>
          <th>رقم المادة</th><th>الصنف</th><th>الكمية بالحبة</th><th>السعر</th><th>القيمة</th><th>ملاحظات</th>
        </tr></thead><tbody>{result.rows.map(row=><tr key={row.key}>
          <td>{row.code||row.sapCode}</td><td>{row.name}</td><td>{row.transfer??'—'}</td>
          <td>{money(row.unitPrice)}</td><td>{money(row.expected)}</td>
          <td>{row.errors.join('، ')||'—'}</td></tr>)}</tbody></table></div>}
      </section>}
    </div>}
  </div>;
}
