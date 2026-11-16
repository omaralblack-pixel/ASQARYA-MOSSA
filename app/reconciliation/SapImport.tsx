'use client';

import {useEffect,useMemo,useState} from 'react';
import {Search} from 'lucide-react';
import {digits,invoiceDocumentNo,readReconciliationRecord,transferNumbers,type Draft} from '../lib/reconcile';
import {parseSapImport,type SapImportGroup} from '../lib/sap-import';
import {readSavedSapImport,type SavedSapImport} from '../lib/saved-sap-import';
import {groupSapEvidence,searchArchivedSapEvidence,type SapEvidence} from '../lib/sap-document-lookup';
import {draftFromPaperInvoice} from '../lib/sap-import-paper-invoice';

type SavedRecord={id:string;payload:string};
type PreviewGroup=SapImportGroup&{savedIds:string[];allTransfersSaved:boolean;unsavedMembers:SapImportGroup['members'];originalRecordId?:string;linkedInvoiceNumbers:string[]};

function compareWithSaved(groups:SapImportGroup[],records:SavedRecord[]):PreviewGroup[]{
  const byTransfer=new Map<string,string>();
  const byInvoice=new Map<string,Set<string>>();
  const add=(map:Map<string,Set<string>>,key:string,id:string)=>{const ids=map.get(key)||new Set<string>();ids.add(id);map.set(key,ids)};
  const transferOwners=new Map<string,Set<string>>();
  const invoicesByRecord=new Map<string,string[]>();
  for(const record of records){
    const draft=readReconciliationRecord(record.payload);
    if(!draft)continue;
    for(const transfer of draft.transfers||[]){
      for(const number of transferNumbers(transfer.number||'')){byTransfer.set(number,record.id);add(transferOwners,number,record.id)}
    }
    invoicesByRecord.set(record.id,(draft.invoices||[]).map(invoice=>invoiceDocumentNo(invoice.number)).filter(Boolean));
    for(const invoice of draft.invoices||[]){
      const number = invoiceDocumentNo(invoice.number);
      if (number) add(byInvoice, number, record.id);
    }
  }
  return groups.map(group=>{
    const transferIds=group.draft.transfers.flatMap(transfer=>transferNumbers(transfer.number).flatMap(number=>[...(transferOwners.get(number)||[])]));
    const invoiceIds=group.draft.invoices.flatMap(invoice=>[...(byInvoice.get(invoiceDocumentNo(invoice.number||''))||[])]);
    const savedIds=[...new Set([...transferIds,...invoiceIds])];
    const unsavedMembers=group.members.filter(member=>!transferOwners.has(member.transfer.number));
    const allTransfersSaved=unsavedMembers.length===0;
    const original=group.members[0].canceledTransferNo;
    const linkedInvoiceNumbers=[...new Set(savedIds.flatMap(id=>invoicesByRecord.get(id)||[]))];
    return {...group,savedIds,allTransfersSaved,unsavedMembers,linkedInvoiceNumbers,originalRecordId:original?byTransfer.get(original):undefined};
  });
}

const searchText=(value:string)=>digits(value).trim().toLowerCase().replace(/[أإآٱ]/g,'ا').replace(/[\u064B-\u065F\u0670ـ]/g,'');
const keyOf=(group:SapImportGroup)=>group.draft.transfers[0].number;
const isReady=(group:PreviewGroup)=>!group.reversal&&!group.issues.length&&!group.savedIds.length;
export default function SapImport({branches,records,readRecords,saveDraft,openDraft,openSaved,onPreview}:{
  branches:string[];
  records:SavedRecord[];
  readRecords:()=>Promise<SavedRecord[]>;
  saveDraft:(draft:Draft)=>Promise<string>;
  openDraft:(draft:Draft)=>void;
  openSaved:(id:string)=>void;
  onPreview:(groups:SapImportGroup[],records:SavedRecord[])=>void;
}){
  const [paste,setPaste]=useState('');
  const [savedFile,setSavedFile]=useState<SavedSapImport>();
  const [loadingFile,setLoadingFile]=useState(true);
  const [fileError,setFileError]=useState('');
  const [importedGroups,setGroups]=useState<SapImportGroup[]>([]);
  const [issues,setIssues]=useState<string[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [notification,setNotification]=useState<{text:string;error:boolean}|null>(null);
  const [errors,setErrors]=useState<Record<string,string>>({});
  const [filter,setFilter]=useState('pending');
  const [query,setQuery]=useState('');
  const [paperInvoice,setPaperInvoice]=useState('');
  const [paperTransfer,setPaperTransfer]=useState('');
  const [paperBusy,setPaperBusy]=useState(false);
  const [paperError,setPaperError]=useState('');
  const groups=useMemo(()=>compareWithSaved(importedGroups,records),[importedGroups,records]);
  const pending=groups.filter(group=>!group.reversal&&!group.allTransfersSaved);
  const ready=groups.filter(isReady);
  const selectedGroups=ready.filter(group=>selected.includes(keyOf(group)));
  const search=searchText(query);
  const visibleMembers=(group:PreviewGroup)=>!!search||filter==='saved'||group.reversal?group.members:group.unsavedMembers;
  const matching=groups.filter(group=>!search||[
    group.draft.branch,
    ...visibleMembers(group).flatMap(member=>[member.transfer.number,member.branchLabel,member.canceledTransferNo||'']),
    ...group.draft.invoices.map(invoice=>invoice.number),
    ...group.linkedInvoiceNumbers,
  ].some(value=>searchText(value).includes(search)));
  const reversals=groups.filter(group=>group.reversal);
  const visibleReversals=matching.filter(group=>group.reversal);
  // Explicit searches cross the status filter: a stored transfer must never
  // disappear just because the default filter is 'not yet saved'.
  const shown=matching.filter(group=>!group.reversal&&(search?true:filter==='saved'?group.allTransfersSaved:
    !group.allTransfersSaved&&(filter==='pending'||(filter==='ready'?isReady(group):!isReady(group)))));
  const shownReady=shown.filter(isReady);
  const hiddenSelected=selectedGroups.filter(group=>!shown.includes(group)).length;

  useEffect(()=>{
    if(!branches.length)return;
    let active=true;
    async function restore(){
      try{
        const saved=await readSavedSapImport();
        if(!active||!saved)return;
        setSavedFile(saved);
        setPaste(saved.text);
        await preview(saved.text,()=>active);
      }catch{
        if(active)setFileError('تعذّر قراءة ملف SAP المحفوظ على Supabase.');
      }finally{
        if(active)setLoadingFile(false);
      }
    }
    void restore();
    return ()=>{active=false};
  },[branches]);

  useEffect(()=>{if(fileError)setNotification({text:fileError,error:true})},[fileError]);
  useEffect(()=>{if(issues.length)setNotification({text:issues.join(' · '),error:true})},[issues]);
  useEffect(()=>{if(message)setNotification({text:message,error:message.startsWith('تعذّر')})},[message]);

  async function preview(text=paste,isActive=()=>true){
    let parsedTransferCount=0;
    setBusy(true);
    setMessage('');
    setGroups([]);
    onPreview([],[]);
    setSelected([]);
    setIssues([]);
    setErrors({});
    try{
      const result=parseSapImport(text,branches);
      parsedTransferCount=result.groups.reduce((count,group)=>count+group.members.length,0);
      setIssues(result.issues);
      const records=await readRecords();
      if(!isActive())return;
      setGroups(result.groups);
      onPreview(result.issues.length?[]:result.groups,records);
      setFilter('pending');
      setQuery('');
    }catch(error){
      if(isActive())setIssues([
        ...(parsedTransferCount?['تمت قراءة '+parsedTransferCount+' ترحيلًا من SAP، لكن تعذّر جلب سجلات المطابقة. النسخة المحفوظة لم تُحذف.']:[]),
        error instanceof Error?error.message:'تعذّر تجهيز المعاينة',
      ]);
    }finally{
      if(isActive())setBusy(false);
    }
  }

  async function openPaperInvoice(){
    const invoice=invoiceDocumentNo(paperInvoice||query);
    const transferNo=digits(paperTransfer||(/^-?\d{4,20}$/.test(search)?search:'')).trim();
    setPaperError('');
    if(!/^\d{10}$/.test(invoice)||!/^\d{4,20}$/.test(transferNo)){
      setPaperError('اكتب رقم الفاتورة الورقية (10 خانات) ورقم ترحيل SAP الصحيح من الورقة.');
      return;
    }
    setPaperBusy(true);
    try{
      // Check the current D1 reconciliation register before creating any draft.
      // Existing owner records must be opened in place, never duplicated.
      const latest=await readRecords();
      const recordsWithDraft=latest.map(row=>({row,draft:readReconciliationRecord(row.payload)}));
      const invoiceOwner=recordsWithDraft.find(({draft})=>
        draft?.invoices.some(item=>invoiceDocumentNo(item.number)===invoice));
      const transferOwner=recordsWithDraft.find(({draft})=>
        draft?.transfers.some(item=>transferNumbers(item.number).includes(transferNo)));
      if(invoiceOwner){
        setPaperError('الفاتورة '+invoice+' محفوظة بالفعل في السجل. تم فتح سجلها الأصلي؛ راجع ربط الترحيل '+transferNo+' قبل أي تعديل.');
        openSaved(invoiceOwner.row.id);
        return;
      }
      if(transferOwner){
        setPaperError('الترحيل '+transferNo+' محفوظ بالفعل بدون هذه الفاتورة. تم فتح كشفه الأصلي؛ اكتب رقم الفاتورة الورقية فيه ثم راجع واحفظ. لا ننشئ نسخة ثانية.');
        openSaved(transferOwner.row.id);
        return;
      }
      let member=groups.flatMap(group=>group.members).find(item=>item.transfer.number===transferNo);
      if(!member){
        const response=await fetch('/api/reconcile?sapLookup='+encodeURIComponent(transferNo),{cache:'no-store'});
        const result=await response.json() as {hits?:SapEvidence[];partial?:boolean;error?:string};
        if(!response.ok)throw Error(result.error||'تعذّر فحص ترحيلات SAP المستوردة.');
        if(result.partial)throw Error('فحص ترحيلات SAP غير مكتمل؛ استخدم رقم الترحيل الكامل.');
        member=groupSapEvidence(result.hits||[],transferNo,'transfer')?.members
          .find(item=>item.transfer.number===transferNo);
      }
      if(!member){
        const archived=await searchArchivedSapEvidence(transferNo,'transfer',branches);
        if(archived.unreadable)throw Error('هناك ملفات SAP مؤرشفة لم تُقرأ؛ يلزم مراجعتها قبل الربط.');
        member=groupSapEvidence(archived.hits,transferNo,'transfer')?.members
          .find(item=>item.transfer.number===transferNo);
      }
      if(!member)throw Error('الترحيل '+transferNo+' غير موجود في كشوف SAP المتاحة. ارفع كشف الترحيلات الأصلي من «ملفات SAP» أولًا.');
      const proposal=draftFromPaperInvoice(member,invoice);
      openDraft(proposal);
      setMessage('تم فتح الترحيل '+transferNo+' للربط اليدوي بالفاتورة الورقية '+invoice+'. لم تُحفظ أي مطابقة بعد.');
    }catch(error){
      setPaperError(error instanceof Error?error.message:'تعذّر التحقق من الربط الورقي.');
    }finally{
      setPaperBusy(false);
    }
  }

  async function saveSelected(){
    setBusy(true);
    setMessage('');
    setErrors({});
    let saved=0;
    let failed=0;
    try{
      const records=await readRecords();
      const current=compareWithSaved(selectedGroups,records);
      const newlySaved:SavedRecord[]=[];
      for(const group of current){
        const key=keyOf(group);
        try{
          if(group.savedIds.length){
            throw Error('الترحيل أو الفاتورة محفوظة مسبقًا. افتحها من السجل.');
          }
          const id=await saveDraft(group.draft);
          saved++;
          newlySaved.push({id,payload:JSON.stringify(group.draft)});
        }catch(error){
          failed++;
          setErrors(previous=>({...previous,[key]:error instanceof Error?error.message:'تعذّر الحفظ'}));
        }
      }
      onPreview(importedGroups,[...records,...newlySaved]);
      setMessage('تم حفظ '+saved+' كشف'+(failed?'، و'+failed+' بحاجة لمراجعة.':'.'));
    }catch(error){
      setMessage(error instanceof Error?error.message:'تعذّر التحقق من السجل');
    }finally{
      setBusy(false);
    }
  }

  return <><details className="panel sap-import">
    <summary>استيراد ترحيلات SAP دفعة واحدة</summary>
    <p className="hint">تُقرأ نتيجة كويري المؤسسة من الكشف المحفوظ في ملفات SAP. المعاينة تجمع البنود حسب الترحيل وتقرأ أرقام الفواتير من Remarks.</p>
    <p><a className="button secondary" href="/reconciliation?view=sap-files">ملفات SAP — رفع وإدارة الكشوف المشتركة</a></p>
    {loadingFile&&<p className="hint">جاري استرجاع كشف SAP المحفوظ…</p>}
    {savedFile&&<p className="hint">الملف المحفوظ على Supabase <b dir="auto">{savedFile.name}</b></p>}
    {fileError&&<div className="banner error" role="alert">{fileError}</div>}
    <label>كشف SAP المحفوظ<textarea readOnly className="serial-input" dir="ltr" value={paste} disabled={busy||loadingFile} onChange={event=>{
      setPaste(event.target.value);
      onPreview([],[]);
      setGroups([]);
      setIssues([]);
      setSelected([]);
      setQuery('');
      setMessage('');
    }}/></label>
    <button className="button primary" type="button" disabled={busy||loadingFile||!paste.trim()} onClick={()=>preview()}>معاينة الاستيراد</button>
    <details className="paper-invoice-link">
      <summary>ربط فاتورة زرقاء من نسخة SAP المطبوعة برقم الترحيل</summary>
      <p className="hint">إذا ظهرت الفاتورة على ورقة SAP ولم تظهر في عمود Remarks أو Journal Remarks بالكشف المحفوظ، ابحث برقم الترحيل. سيُفتح السجل الأصلي إن كان محفوظًا، أو مسودة غير محفوظة للمراجعة. لا تتغير ملفات SAP أو الاعتمادات تلقائيًا.</p>
      <div className="form-grid">
        <label>رقم الفاتورة الزرقاء على الورقة<input aria-label="رقم الفاتورة الزرقاء من الورقة" dir="ltr" inputMode="numeric" value={paperInvoice} onChange={event=>setPaperInvoice(event.target.value)} placeholder="2623415853"/></label>
        <label>رقم ترحيل SAP<input aria-label="رقم ترحيل SAP من الورقة" dir="ltr" inputMode="numeric" value={paperTransfer} onChange={event=>setPaperTransfer(event.target.value)} placeholder="2616473"/></label>
        <button className="button secondary" type="button" disabled={busy||paperBusy} onClick={()=>void openPaperInvoice()}>{paperBusy?'جارٍ التحقق…':'فحص وفتح الترحيل للمراجعة'}</button>
      </div>
      {paperError&&<p className="red" role="alert">{paperError}</p>}
    </details>
    {issues.length>0&&<div className="banner error" role="alert">{issues.join(' · ')}</div>}
    {groups.length>0&&<>
      <div className="table-controls">
        <div className="search"><Search size={16}/><input type="search" aria-label="بحث في نتائج استيراد SAP" placeholder="ابحث برقم الترحيل أو الفاتورة أو الفرع" value={query} onChange={event=>{setQuery(event.target.value);setSelected([])}}/></div>
        <button className="button secondary" type="button" aria-pressed={filter==='reversal'} onClick={()=>setFilter(filter==='reversal'?'pending':'reversal')}>
          {filter==='reversal'?'رجوع لمعاينة الاستيراد':'الترحيلات الملغاة ('+reversals.length+')'}
        </button>
      </div>
      {filter==='reversal'?<>
        <h2>الترحيلات الملغاة</h2>
        <p className="hint">رقم الترحيل الأصلي يُقرأ من Remarks. السطر أدناه يربط الأصل بمستند عكس الإلغاء.</p>
        <div className="table-scroll"><table>
          <thead><tr><th>مستند عكس الإلغاء</th><th>الترحيل الأصلي المقابل</th><th>تاريخ العكس</th><th>الفرع</th><th>البنود</th><th>Remarks</th><th>السجل</th></tr></thead>
          <tbody>{visibleReversals.map(group=>{
            const member=group.members[0];
            return <tr key={member.transfer.number}>
              <td><code>{member.transfer.number}</code></td>
              <td>{member.canceledTransferNo?<code>{member.canceledTransferNo}</code>:'رقم الأصل غير مذكور'}</td>
              <td>{member.transfer.date||'—'}</td>
              <td>{member.branch||member.branchLabel||'—'}</td>
              <td>{member.lineCount}</td>
              <td dir="auto">{member.remarks||'—'}</td>
              <td>{group.originalRecordId?<button className="button secondary small" type="button" disabled={busy} onClick={()=>openSaved(group.originalRecordId!)}>فتح الترحيل الأصلي</button>:member.canceledTransferNo?'الأصل غير مسجّل هنا':'بحاجة لمراجعة'}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {!visibleReversals.length&&<p className="hint">{search?'ما في ترحيلات ملغاة بتطابق البحث.':'ما في مستندات عكس إلغاء بالكشف الملصوق.'}</p>}
      </>:<>
      <div className="table-controls">
        <select aria-label="حالة الاستيراد" value={filter} onChange={event=>setFilter(event.target.value)}>
          <option value="pending">غير محفوظة في السجل ({pending.length})</option>
          <option value="ready">جاهزة للحفظ ({ready.length})</option>
          <option value="saved">مسجّلة سابقًا</option>
          <option value="review">بحاجة لمراجعة</option>
        </select>
        <button className="button secondary" type="button" disabled={busy||!shownReady.length||!!issues.length} onClick={()=>setSelected(shownReady.map(keyOf))}>تحديد الكشوف الجاهزة الظاهرة</button>
        <button className="button primary" type="button" disabled={busy||!selectedGroups.length||!!issues.length} onClick={saveSelected}>حفظ المحدد ({selectedGroups.length})</button>
      </div>
      {hiddenSelected>0&&<p className="hint">المحدد يشمل {hiddenSelected} كشف خارج النتائج الظاهرة.</p>}
      <p className="hint">الترحيل بلا رقم فاتورة يُحفظ لوحده. بعد ما توصلك الفاتورة الزرقاء، افتح الترحيل وسجّل رقمها. لإضافة ترحيل أو عكسي استخدم «إضافة ترحيل» من الكشف المفتوح.</p>
      {message&&<p role="status">{message}</p>}
      <div className="table-scroll"><table>
        <thead><tr><th>تحديد</th><th>الترحيلات</th><th>الفرع</th><th>الفواتير الزرقاء</th><th>البنود</th><th>الحالة</th><th>فتح</th></tr></thead>
        <tbody>{shown.map(group=>{
          const key=keyOf(group);
          const members=visibleMembers(group);
          return <tr key={key}>
            <td>{isReady(group)&&<input className="sap-import-check" type="checkbox" aria-label={'تحديد كشف '+key}
              checked={selected.includes(key)} disabled={busy||!!issues.length}
              onChange={event=>setSelected(previous=>event.target.checked?[...previous,key]:previous.filter(item=>item!==key))}/>}</td>
            <td>{members.map(item=><details key={item.transfer.number}>
              <summary><code>{item.transfer.number}</code></summary><p dir="auto">{item.remarks||'بدون Remarks'}</p>
            </details>)}</td>
            <td>{group.draft.branch||group.members[0].branchLabel||'—'}</td>
            <td dir="ltr">{group.draft.invoices.map(invoice=>invoice.number).filter(Boolean).join('، ')||'—'}
              {group.linkedInvoiceNumbers.some(number=>!group.draft.invoices.some(invoice=>invoiceDocumentNo(invoice.number)===number))&&
                <small>محفوظ بالسجل: {group.linkedInvoiceNumbers.filter(number=>!group.draft.invoices.some(invoice=>invoiceDocumentNo(invoice.number)===number)).join('، ')}</small>}</td>
            <td>{members.reduce((count,item)=>count+item.lineCount,0)}</td>
            <td>{group.allTransfersSaved?'محفوظ':group.savedIds.length?'مرتبط بسجل سابق':group.issues.join('، ')||
              (group.draft.invoices.some(invoice=>invoiceDocumentNo(invoice.number))?'جاهز للحفظ':'ترحيل بلا فاتورة زرقاء')}
              {errors[key]&&<p className="red">{errors[key]}</p>}</td>
            <td>{group.savedIds.map((id,index)=><button key={id} type="button" className="button secondary small"
              disabled={busy} onClick={()=>openSaved(id)}>فتح المحفوظ {index+1}</button>)}
              {!group.savedIds.length&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>openDraft(group.draft)}>فتح للمراجعة</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!shown.length&&<p className="hint">{search?'الرقم غير ظاهر في Remarks أو سجل الفواتير المرتبطة بالكشف الحالي. إذا موجود على ورقة SAP المطبوعة، استخدم «ربط فاتورة ورقية برقم ترحيل» أدناه.':filter==='pending'?'كل الترحيلات في هذه القائمة محفوظة بالسجل.':'ما في كشوف بهالحالة.'}</p>}
      </>}
    </>}
  </details>{notification&&<div className="modal-backdrop notification-backdrop"><section className="modal panel notification-dialog" role="alertdialog" aria-modal="true" aria-label={notification.error?'تنبيه':'إشعار'}><h2>{notification.error?'تنبيه':'إشعار'}</h2><p>{notification.text}</p><div className="notification-actions"><button type="button" className="button primary" onClick={()=>setNotification(null)}>حسنًا</button></div></section></div>}</>;
}
