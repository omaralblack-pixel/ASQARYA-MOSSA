'use client';

import {useEffect, useMemo, useState} from 'react';
import {CheckCircle2, AlertTriangle, Plus, Search, Save, ArrowLeft, RefreshCw, Trash2} from 'lucide-react';
import GroupLookup from './GroupLookup';
import {readSavedSapImport} from '../lib/saved-sap-import';
import {parseSapImport, type SapImportGroup} from '../lib/sap-import';
import {prepareReconciliation, parseTransfer, withInvoiceDates, editInvoiceDate, transferNumbers, invoiceDocumentNo, digits, fils, money, dateValue, type Draft, type Invoice, type Item, type Transfer, type TransferSource} from '../lib/reconcile';

type Summary = {id:string; branch:string; version:number; payload:string};
type SavedTransfer = {transfer:Transfer; invoiceNumbers:string[]; recordId:string; version:number; branch:string};
type SearchKind = 'invoice' | 'transfer';
type SearchFilter = SearchKind | 'all';
type DocumentHit = {kind:SearchKind; number:string; branch:string; origin:'saved'|'sap'};

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

async function getJson<T extends object>(url:string):Promise<T> {
  const response = await fetch(url, {cache:'no-store'});
  const data = await response.json() as T & {error?:string};
  if (!response.ok) throw Error(data.error || 'تعذّر استرجاع البيانات');
  return data;
}
async function saveJson(draft:Draft, sources:TransferSource[]) {
  const response = await fetch('/api/reconcile', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'save', draft, transferSources:sources})
  });
  const data = await response.json() as {error?:string};
  if (!response.ok) throw Error(data.error || 'تعذّر الحفظ');
  return data as {id:string;version:number;referenceSnapshot:Item[]};
}
function recordDraft(row:Summary):Partial<Draft> {
  try { return JSON.parse(row.payload) as Draft; } catch { return {}; }
}
function matchesRecord(row:Summary, number:string, kind:SearchKind) {
  const saved = recordDraft(row);
  return kind==='invoice'
    ? (saved.invoices || []).some(item=>invoiceDocumentNo(item.number)===number)
    : (saved.transfers || []).some(item=>transferNumbers(item.number).includes(number));
}
function matchingDocuments(rows:Summary[], groups:SapImportGroup[], query:string, filter:SearchFilter):DocumentHit[] {
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
  return [...matches.values()].sort((a,b)=>
    (a.number===searched?-1:0)-(b.number===searched?-1:0) ||
    a.kind.localeCompare(b.kind) ||
    b.number.localeCompare(a.number,'en',{numeric:true}));
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
  reference, branches, onDetailed
}:{
  reference:Item[];
  branches:string[];
  onDetailed:(draft:Draft, sources:Record<string,TransferSource>)=>void;
}) {
  const [records, setRecords] = useState<Summary[]>([]);
  const [imports, setImports] = useState<SapImportGroup[]>([]);
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
  const suggestions=useMemo(()=>matchingDocuments(records,imports,number,kind),[records,imports,number,kind]);

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
    async function initialize() {
      const results = await Promise.allSettled([
        getJson<{records:Summary[]}>('/api/reconcile?records=1'),
        readSavedSapImport()
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
  },[branches]);

  function update(next:Draft) {
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
    const saved = JSON.parse(data.record.payload) as Draft;
    setDraft(withInvoiceDates(fillSearchedAmount({...saved,mode:'manual',id:data.record.id,version:data.record.version,checks:saved.checks||{}},target,searchKind)));
    setSources({});
    setNotice('تم استرجاع الكشف المحفوظ. تقدر تعدّل الأسعار أو تضيف ترحيل بدون إنشاء سجل مكرر.');
  }

  async function lookup(query=number, selectedKind:SearchFilter=kind) {
    const searched = digits(query).trim();
    if (!/^\d{4,20}$/.test(searched)) {setError('اكتب رقم فاتورة أو ترحيل صحيحًا.');return}
    const options=matchingDocuments(records,imports,searched,selectedKind);
    const exact=options.some(item=>item.number===searched);
    if (searched.length===4 || (!exact&&options.length>0)) {
      setSuggestionsOpen(true);
      setError(options.length?'اختر رقم الفاتورة أو الترحيل الكامل من نتائج البحث قبل المتابعة.':'ما لقيت مستندًا بهذه الخانات. لإضافة مستند جديد أدخل رقمه كاملًا.');
      return;
    }
    const searchKind:SearchKind=selectedKind==='all'?(searched.length>=9?'invoice':'transfer'):selectedKind;
    if (searchKind==='invoice'&&initialAmount.trim()&&fils(initialAmount)===null) {
      setError('أدخل مبلغ الفاتورة بشكل صحيح، مثل 186.400 دينار.');return;
    }
    setBusy(true);setSuggestionsOpen(false);setError('');setNotice('');setShowItems(false);
    try {
      const rows = await refreshRecords();
      const found = rows.filter(row=>matchesRecord(row,searched,searchKind));
      if (found.length>1) throw Error('رقم المستند مكرر في السجل؛ يلزم مراجعة المطابقة الأساسية.');
      if (found.length===1) { await loadRecord(found[0],searched,searchKind);return; }

      const candidate = imports.find(group=>group.members.some(member=>
        searchKind==='invoice'?member.invoices.includes(searched):member.transfer.number===searched));
      if (candidate) {
        if (candidate.reversal || candidate.members.some(member=>member.reversal || member.issues.length)) {
          throw Error('أحد ترحيلات هذا المستند ملغى أو فيه مشكلة قراءة من SAP. افتح المطابقة الأساسية لمراجعته قبل اعتماد أي مبلغ.');
        }
        const proposed = fillSearchedAmount(fromSap(candidate,searched,searchKind),searched,searchKind);
        const occupied = proposed.transfers.flatMap(item=>rows
          .filter(row=>matchesRecord(row,item.number,'transfer'))
          .map(row=>({row,number:item.number})));
        if (occupied.some(({row})=>(recordDraft(row).invoices||[]).some(inv=>invoiceDocumentNo(inv.number)))) {
          throw Error('في ترحيل مرتبط بفاتورة زرقاء محفوظة. افتح الفاتورة من السجل بدل تكرارها.');
        }
        const first = occupied[0];
        if (first) {
          // Keep a previously saved, invoice-free transfer as the owner of the new invoice.
          const original = await getJson<{record:Summary}>('/api/reconcile?id='+encodeURIComponent(first.row.id));
          const base = JSON.parse(original.record.payload) as Draft;
          const other = proposed.transfers.filter(row=>row.number!==first.number);
          const baseTransfer = base.transfers.find(row=>transferNumbers(row.number).includes(first.number));
          if (!baseTransfer || transferNumbers(baseTransfer.number).length!==1)
            throw Error('الترحيل محفوظ مع أرقام أخرى في نفس البطاقة. افتحه من سجل المطابقات أولًا.');
          const all = [{...baseTransfer},...other];
          const nextSources:Record<string,TransferSource> = {};
          for (const item of other) {
            const owner = occupied.find(entry=>entry.number===item.number);
            if (owner && owner.row.id!==first.row.id) {
              nextSources[item.id]={number:item.number,recordId:owner.row.id,version:owner.row.version};
            }
          }
          setSources(nextSources);
          setDraft(withInvoiceDates({...proposed,id:original.record.id,version:original.record.version,
            transfers:all,branch:proposed.branch||base.branch,
            referenceSnapshot:base.referenceSnapshot,useCurrentReference:true}));
          setNotice('تم جلب الترحيلات من SAP وربط السجل السابق الذي لا يحمل فاتورة، بدون تكراره.');
        } else {
          setSources({});
          setDraft(proposed);
          setNotice('تم العثور على الترحيلات المرتبطة في كشف SAP. أدخل مبلغ كل فاتورة زرقاء.');
        }
      } else if (searchKind==='transfer') {
        const savedResponse = await fetch('/api/reconcile?transfer='+encodeURIComponent(searched),{cache:'no-store'});
        if (savedResponse.ok) {
          const saved = await savedResponse.json() as SavedTransfer;
          const row = rows.find(item=>item.id===saved.recordId);
          if (row) {await loadRecord(row);return}
        } else if (savedResponse.status!==404) {
          throw Error(((await savedResponse.json()) as {error?:string}).error||'تعذّر البحث عن الترحيل.');
        }
        setSources({});
        setDraft({...fresh(),transfers:[{id:uuid(),number:searched,date:localDate(),paste:''}]});
        setNotice('الترحيل مش موجود بكشف SAP المحفوظ. ألصق جدوله يدويًا، واكتب رقم فاتورته الزرقاء.');
      } else {
        setSources({});
        setDraft(fillSearchedAmount(fresh(searched),searched,searchKind));
        setNotice('ما لقيت ترحيلات مرتبطة بهذا الرقم. أضف أرقام الترحيلات من الحقل الموجود تحت.');
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
      const response=await fetch('/api/reconcile?transfer='+encodeURIComponent(searched),{cache:'no-store'});
      if (response.ok) stored=await response.json() as SavedTransfer;
      else if (response.status!==404) throw Error(((await response.json()) as {error?:string}).error||'تعذّر فحص الترحيل.');
      if (stored && stored.recordId!==draft.id && stored.invoiceNumbers.length) {
        throw Error('الترحيل '+searched+' يحمل فاتورة زرقاء رقم '+stored.invoiceNumbers.join('، ')+'، ولا يمكن إضافته كترحيل ثانٍ.');
      }
      if (stored && stored.recordId===draft.id) throw Error('الترحيل موجود مسبقًا في السجل الحالي.');
      const member = imports.flatMap(group=>group.members).find(item=>item.transfer.number===searched);
      if (member && (member.reversal || member.issues.length)) {
        throw Error('الترحيل '+searched+' ملغى أو فيه ملاحظات قراءة من SAP. راجعه في شاشة المطابقة الأساسية قبل إضافته.');
      }
      if (draft.transfers.length>0 && member?.invoices.length) {
        throw Error('الترحيل '+searched+' يحمل فاتورة زرقاء في كشف SAP. أضف فقط ترحيلًا بلا فاتورة.');
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
        const base=JSON.parse(data.record.payload) as Draft;
        setDraft(withInvoiceDates({...base,id:stored.recordId,version:stored.version,
          invoices:draft.invoices,branch:draft.branch||stored.branch,mode:'manual',checks:{}}));
        setSources({});
      } else {
        const chosen = stored?.transfer || member?.transfer || {id:uuid(),number:searched,date:localDate(),paste:''};
        const item = {...chosen,id:uuid(),number:searched};
        update({...draft,branch:draft.branch||stored?.branch||member?.branch||'',
          transfers:[...draft.transfers,item]});
        if (stored && stored.recordId!==draft.id) {
          setSources(current=>({...current,[item.id]:{number:searched,recordId:stored.recordId,version:stored.version}}));
        }
      }
      setTransferNumber('');
      setNotice(stored||member?'تمت إضافة الترحيل '+searched+' وأصنافه.':'الترحيل غير موجود في TXT؛ ألصق بنوده وتاريخه قبل الحفظ.');
    } catch(e) {setError(e instanceof Error?e.message:'تعذّر إضافة الترحيل.')}
    finally {setBusy(false);}
  }

  const prepared=useMemo(()=>draft?prepareReconciliation(draft,reference):null,[draft,reference]);
  const result=prepared?.result??null;
  const transferWarnings=useMemo(()=>draft ? draft.transfers.flatMap(transfer=>{
    const parsed=parseTransfer(transfer.paste,{allowReverse:true});
    return [...parsed.issues,...parsed.excluded].map(issue=>'الترحيل '+transfer.number+': '+issue);
  }):[],[draft]);
  const canSave=!!draft&&!!result&&result.status==='match'&&result.priceDifference===0
    &&transferWarnings.length===0&&!!draft.branch
    &&draft.transfers.every(item=>item.number&&item.paste.trim()&&dateValue(item.date))
    &&draft.invoices.every(item=>invoiceDocumentNo(item.number)&&fils(item.amount)!==null&&dateValue(item.date));
  async function saveAndNext() {
    if (!prepared||!canSave) return;
    setBusy(true);setError('');
    try {
      await saveJson(prepared.draft,Object.values(sources));
      await refreshRecords();
      setDraft(null);setSources({});setNumber('');setInitialAmount('');setTransferNumber('');setShowItems(false);setSuggestionsOpen(false);
      setNotice('تم حفظ المطابقة في السجل. أدخل رقم الفاتورة التالية.');
    } catch(e) {setError(e instanceof Error?e.message:'تعذّر حفظ المطابقة.')}
    finally {setBusy(false);}
  }

  return <div className="instant-match" dir="rtl">
    <div className="page-title">
      <div><p className="eyebrow">سير عمل سريع</p><h1>مطابقة فورية</h1>
        <p>اكتب رقم الفاتورة الزرقاء، اسحب ترحيلات SAP، أدخل مبالغ الفواتير، وراجع الفرق مباشرة.</p></div>
      <button type="button" className="button secondary" disabled={busy||loading} onClick={()=>{setDraft(null);setSources({});setNumber('');setInitialAmount('');setTransferNumber('');setError('');setNotice('');setSuggestionsOpen(false)}}>
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
            <input id="instant-document-number" dir="ltr" inputMode="numeric" autoComplete="off"
              value={number} onChange={e=>{setNumber(e.target.value);setSuggestionsOpen(true);setError('')}}
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
                <p className="instant-results-heading">ما في أرقام مطابقة بالملف المحفوظ أو السجل. إذا المستند جديد، أدخل رقمه الكامل.</p>}
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
    </section>

    {draft&&<div style={{display:'grid',gap:16}}>
      <section className="panel">
        <div className="section-title"><h2>بيانات الفواتير والترحيلات</h2></div>
        <div className="form-grid">
          <GroupLookup label="الفرع" items={branches} required value={draft.branch} onChange={branch=>update({...draft,branch})} placeholder="ابحث باسم الفرع أو رقمه"/>
          <label>تاريخ الكشف<input type="date" value={draft.date} onChange={e=>update({...draft,date:e.target.value})}/></label>
        </div>
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
                onChange={e=>update({...draft,invoices:editInvoiceDate(draft.invoices,item.id,e.target.value)})}/></label>
            </div>
            <label className="check-label"><input type="checkbox" checked={item.complete}
              onChange={e=>updateInvoice(item.id,{complete:e.target.checked})}/>الفاتورة الورقية موجودة عندي</label>
            {index>0&&<button className="text-button" type="button"
              onClick={()=>update({...draft,invoices:draft.invoices.filter(row=>row.id!==item.id)})}>حذف الفاتورة</button>}
          </article>)}
        </div>
        <button className="button secondary" type="button" disabled={draft.invoices.length>=30}
          onClick={()=>update({...draft,invoices:[...draft.invoices,invoice()]})}><Plus size={16}/>إضافة فاتورة زرقاء</button>
      </section>
      <section className="panel">
        <div className="section-title"><h2>ترحيلات SAP</h2></div>
        <div className="form-grid">
          <label>أدخل رقم الترحيل لإضافته مباشرة<input dir="ltr" inputMode="numeric" value={transferNumber}
            onChange={e=>setTransferNumber(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void addTransfer()}}
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
        <div className="stats">
          <div className="stat"><span>مجموع الفواتير الزرقاء</span><strong>{money(result.total)} د.أ</strong></div>
          <div className="stat"><span>قيمة الترحيلات بأسعار المؤسسة</span><strong>{money(result.expected)} د.أ</strong></div>
          <div className="stat"><span>الفرق (الفواتير − الترحيلات)</span><strong dir="ltr">{money(result.priceDifference)} د.أ</strong></div>
          <div className={'stat status-stat '+result.status}><span>الحالة</span>
            <strong>{result.status==='match'&&result.priceDifference===0&&!transferWarnings.length?'مطابق':result.status==='difference'||result.priceDifference!==null&&result.priceDifference!==0?'غير مطابق':'بحاجة مراجعة'}</strong></div>
        </div>
        {draft.invoices.length>1&&<p className="hint">النتيجة هنا لمجموع الفواتير المرتبطة؛ مطابقة مبلغ كل فاتورة منفردة تتطلب توزيع الأصناف على صفحاتها في شاشة المطابقة التفصيلية.</p>}
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
          <button type="button" className="button secondary" onClick={()=>onDetailed(prepared?.draft??draft,sources)}>
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
