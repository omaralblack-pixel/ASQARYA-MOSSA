'use client';

import {useEffect,useMemo,useState,type ChangeEvent} from 'react';
import {Search} from 'lucide-react';
import {digits,documentNo,parseTransfer,transferNumbers,type Draft} from '../lib/reconcile';
import {parseSapImport,type SapImportGroup} from '../lib/sap-import';
import {mergeSelectedTransfers,isLinkableReverse} from '../lib/link-sap-groups';
import {deleteSavedSapImport,maxSapFileBytes,readSavedSapImport,saveSapImport,type SavedSapImport} from '../lib/saved-sap-import';

type SavedRecord={id:string;branch:string;payload:string};
type PreviewGroup=SapImportGroup&{savedIds:string[];allTransfersSaved:boolean;originalRecordId?:string};

function compareWithSaved(groups:SapImportGroup[],records:SavedRecord[]):PreviewGroup[]{
  const byTransfer=new Map<string,string>();
  const byInvoice=new Map<string,Set<string>>();
  const add=(map:Map<string,Set<string>>,key:string,id:string)=>{const ids=map.get(key)||new Set<string>();ids.add(id);map.set(key,ids)};
  const transferOwners=new Map<string,Set<string>>();
  for(const record of records){
    const draft=JSON.parse(record.payload) as Draft;
    for(const transfer of draft.transfers||[]){
      for(const number of transferNumbers(transfer.number||'')){byTransfer.set(number,record.id);add(transferOwners,number,record.id)}
    }
    for(const invoice of draft.invoices||[]){
      if(invoice.number)add(byInvoice,documentNo(invoice.number),record.id);
    }
  }
  return groups.map(group=>{
    const transferIds=group.draft.transfers.flatMap(transfer=>transferNumbers(transfer.number).flatMap(number=>[...(transferOwners.get(number)||[])]));
    const invoiceIds=group.draft.invoices.flatMap(invoice=>[...(byInvoice.get(documentNo(invoice.number||''))||[])]);
    const savedIds=[...new Set([...transferIds,...invoiceIds])];
    const allTransfersSaved=group.draft.transfers.every(transfer=>transferNumbers(transfer.number).every(number=>transferOwners.has(number)));
    const original=group.members[0].canceledTransferNo;
    return {...group,savedIds,allTransfersSaved,originalRecordId:original?byTransfer.get(original):undefined};
  });
}

const searchText=(value:string)=>digits(value).trim().toLowerCase().replace(/[أإآٱ]/g,'ا').replace(/[\u064B-\u065F\u0670ـ]/g,'');
const keyOf=(group:SapImportGroup)=>group.draft.transfers[0].number;
const isReady=(group:PreviewGroup)=>!group.reversal&&!group.issues.length&&!group.savedIds.length;
function reverseProblem(group:PreviewGroup):string{
 const problems=group.members.flatMap(member=>{
  const parsed=parseTransfer(member.transfer.paste,{allowReverse:true});
  return [...member.issues,...parsed.issues,...parsed.excluded,
   ...(!parsed.lines.length?['لم تُقرأ بنود الترحيل']:[]),
   ...(parsed.lines.some(line=>line.from!=='011')?['الترحيل يحتوي حركة ليست عكسية']:[])];
 });
 return [...new Set(problems)].join('، ')||'راجع بيانات الترحيل.';
}


export default function SapImport({branches,readRecords,readSavedDraft,saveDraft,openDraft,openSaved,onPreview}:{
  branches:string[];
  readRecords:()=>Promise<SavedRecord[]>;
  readSavedDraft:(id:string)=>Promise<Draft>;
  saveDraft:(draft:Draft)=>Promise<string>;
  openDraft:(draft:Draft)=>void;
  openSaved:(id:string)=>void;
  onPreview:(groups:SapImportGroup[],records:SavedRecord[])=>void;
}){
  const [paste,setPaste]=useState('');
  const [savedFile,setSavedFile]=useState<SavedSapImport>();
  const [loadingFile,setLoadingFile]=useState(true);
  const [fileError,setFileError]=useState('');
  const [groups,setGroups]=useState<PreviewGroup[]>([]);
  const [issues,setIssues]=useState<string[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [selectedReverse,setSelectedReverse]=useState<string[]>([]);
  const [selectedForward,setSelectedForward]=useState<string[]>([]);
  const [savedTarget,setSavedTarget]=useState<{key:string;id:string}|null>(null);
  const [previewRecords,setPreviewRecords]=useState<SavedRecord[]>([]);
  const recordedTransferNumbers=useMemo(()=>new Set(previewRecords.flatMap(record=>(JSON.parse(record.payload) as Draft).transfers.flatMap(transfer=>transferNumbers(transfer.number||'')))),[previewRecords]);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [notification,setNotification]=useState<{text:string;error:boolean}|null>(null);
  const [errors,setErrors]=useState<Record<string,string>>({});
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const ready=groups.filter(isReady);
  const selectedGroups=ready.filter(group=>selected.includes(keyOf(group)));
  const search=searchText(query);
  const matching=groups.filter(group=>!search||[
    group.draft.branch,
    ...group.members.flatMap(member=>[member.transfer.number,member.branchLabel,member.canceledTransferNo||'']),
    ...group.draft.invoices.map(invoice=>invoice.number),
  ].some(value=>searchText(value).includes(search)));
  const reversals=groups.filter(group=>group.reversal);
  const visibleReversals=matching.filter(group=>group.reversal);
  const shown=matching.filter(group=>!group.reversal&&(filter==='all'||(
    filter==='ready'?isReady(group):
    filter==='saved'?group.allTransfersSaved:
    !isReady(group)&&!group.allTransfersSaved
  )));
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
    setBusy(true);
    setMessage('');
    setGroups([]);
    onPreview([],[]);
    setSelected([]);setSelectedReverse([]);setSelectedForward([]);setSavedTarget(null);
    setIssues([]);
    setErrors({});
    try{
      const result=parseSapImport(text,branches);
      setIssues(result.issues);
      const records=await readRecords();
      if(!isActive())return;
      setPreviewRecords(records);
      setGroups(compareWithSaved(result.groups,records));
      onPreview(result.issues.length?[]:result.groups,records);
      setFilter('all');
      setQuery('');
    }catch(error){
      if(isActive())setIssues([error instanceof Error?error.message:'تعذّر تجهيز المعاينة']);
    }finally{
      if(isActive())setBusy(false);
    }
  }

  async function persist(file:SavedSapImport){
    if(!file.text.trim())throw Error('كشف SAP فارغ.');
    const result=parseSapImport(file.text,branches);
    if(result.issues.length||!result.groups.length)throw Error(result.issues[0]||'الملف لا يحتوي على ترحيلات قابلة للقراءة.');
    await saveSapImport(file);
    setSavedFile(file);
    setPaste(file.text);
    await preview(file.text);
  }

  async function uploadFile(event:ChangeEvent<HTMLInputElement>){
    const input=event.currentTarget;
    const file=input.files?.[0];
    input.value='';
    if(!file)return;
    setFileError('');
    setBusy(true);
    try{
      if(!/\.txt$/i.test(file.name))throw Error('اختار ملف TXT.');
      if(file.size>maxSapFileBytes)throw Error('حجم الملف يتجاوز 16 ميغابايت.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';
      await persist({name:file.name,text:new TextDecoder(encoding,{fatal:true}).decode(bytes)});
    }catch(error){
      setFileError(error instanceof Error?error.message:'تعذّر رفع الملف وحفظه.');
    }finally{
      setBusy(false);
    }
  }

  async function saveEdits(){
    setFileError('');
    setBusy(true);
    try{
      await persist({name:savedFile?.name||'SAP.txt',text:paste});
    }catch(error){
      setFileError(error instanceof Error?error.message:'تعذّر حفظ التعديلات.');
    }finally{
      setBusy(false);
    }
  }

  async function removeFile(){
    if(!confirm('حذف ملف SAP المحفوظ من Supabase؟'))return;
    setFileError('');
    setBusy(true);
    try{
      await deleteSavedSapImport();
      setSavedFile(undefined);
      setPaste('');
      setGroups([]);
      setIssues([]);
      setSelected([]);setSelectedReverse([]);setSelectedForward([]);setSavedTarget(null);
      setMessage('');
      onPreview([],[]);
    }catch{
      setFileError('تعذّر حذف ملف SAP المحفوظ.');
    }finally{
      setBusy(false);
    }
  }

  async function linkSelectedForReview(){
    setBusy(true);setMessage('');
    try{
      if((savedTarget?1:0)+selected.length!==1)throw Error('حدد مجموعة واحدة: جديدة أو محفوظة، ثم حدد الترحيل المطلوب.');
      const target=groups.find(group=>keyOf(group)===(savedTarget?.key||selected[0]));
      const reverseGroups=groups.filter(group=>selectedReverse.includes(keyOf(group)));
      if(!target)throw Error('المجموعة المحددة لم تعد في المعاينة.');
      if(target.members.some(member=>member.reverseMovement)||target.reversal)throw Error('اختر مجموعة الفواتير الأصلية، ثم حدد العكسي بجانبها.');
      if(reverseGroups.length!==selectedReverse.length)throw Error('تعذر العثور على أحد الترحيلات المحددة.');
      if(!reverseGroups.length&&!selectedForward.length)throw Error('حدد ترحيلًا جديدًا واحدًا على الأقل.');
      if(selectedForward.length&&!savedTarget)throw Error('حدد المجموعة المحفوظة التي تريد إضافة الترحيل إليها.');
      const records=await readRecords();
      const current=compareWithSaved([target,...reverseGroups],records);
      if(savedTarget&&!current[0].savedIds.includes(savedTarget.id))throw Error('السجل المحدد لم يعد مرتبطًا بالمجموعة؛ حدّث المعاينة.');
      if(!savedTarget&&(!isReady(current[0])||current[0].savedIds.length))throw Error('المجموعة أو الفاتورة سُجلت مسبقًا؛ اختر السجل المحفوظ.');
      const targetDraft=savedTarget?await readSavedDraft(savedTarget.id):target.draft;
      const ownerNumbers=new Set(records.flatMap(record=>{
        const stored=JSON.parse(record.payload) as Draft;
        return (stored.transfers||[]).flatMap(transfer=>transferNumbers(transfer.number||''));
      }));
      if(reverseGroups.some(group=>group.draft.transfers.some(transfer=>transferNumbers(transfer.number).some(number=>ownerNumbers.has(number)))))throw Error('أحد الترحيلات العكسية مسجل في مجموعة أخرى.');
      let combined=targetDraft;
      if(selectedForward.length){
        const candidates=target.members.filter(member=>selectedForward.includes(member.transfer.number));
        if(candidates.length!==selectedForward.length)throw Error('حدد الترحيلات الجديدة من صف المجموعة المختارة فقط.');
        const known=new Set(combined.transfers.flatMap(transfer=>transferNumbers(transfer.number)));
        for(const member of candidates){
          if(member.issues.length||member.reverseMovement||member.reversal)throw Error('أحد الترحيلات المحددة يحتاج مراجعة أو عكسي.');
          if(member.branch!==combined.branch)throw Error('الترحيل '+member.transfer.number+' تابع لفرع مختلف.');
          const parsed=parseTransfer(member.transfer.paste,{allowReverse:true});
          if(!parsed.lines.length||parsed.issues.length||parsed.excluded.length||parsed.lines.some(line=>line.to!=='011'))throw Error('راجع اتجاه وبنود الترحيل '+member.transfer.number+'.');
          for(const number of transferNumbers(member.transfer.number)){
            if(known.has(number)||ownerNumbers.has(number))throw Error('الترحيل '+number+' مسجل مسبقًا في مجموعة.');
            known.add(number);
          }
          combined={...combined,transfers:[...combined.transfers,member.transfer]};
        }
      }
      if(reverseGroups.length)combined=mergeSelectedTransfers({...target,draft:combined,issues:[]},reverseGroups);
      if(combined.transfers.length>30)throw Error('عدد الترحيلات يتجاوز الحد المسموح للمجموعة.');
      openDraft(combined);
    }catch(error){setNotification({text:error instanceof Error?error.message:'تعذر ربط الترحيلات.',error:true})}
    finally{setBusy(false)}
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
            setGroups(previous=>previous.map(row=>keyOf(row)===key?group:row));
            throw Error('صار في ترحيل أو فاتورة مسجّلة. راجع المجموعة الموجودة.');
          }
          const id=await saveDraft(group.draft);
          saved++;
          newlySaved.push({id,branch:group.draft.branch,payload:JSON.stringify(group.draft)});
          setGroups(previous=>previous.map(row=>keyOf(row)===key?{...row,savedIds:[id],allTransfersSaved:true}:row));
        }catch(error){
          failed++;
          setErrors(previous=>({...previous,[key]:error instanceof Error?error.message:'تعذّر الحفظ'}));
        }
      }
      onPreview(groups,[...records,...newlySaved]);
      setMessage('تم حفظ '+saved+' مجموعة'+(failed?'، و'+failed+' بحاجة لمراجعة.':'.'));
    }catch(error){
      setMessage(error instanceof Error?error.message:'تعذّر التحقق من السجل');
    }finally{
      setBusy(false);
    }
  }

  return <><details className="panel sap-import">
    <summary>استيراد ترحيلات SAP دفعة واحدة</summary>
    <p className="hint">الصق نتيجة كويري المؤسسة مع عناوين الأعمدة. المعاينة تجمع البنود حسب الترحيل وتقرأ أرقام الفواتير من Remarks.</p>
    <div className="table-controls">
      <label className="button secondary sap-file-picker">
        {savedFile?'استبدال ملف TXT':'إرفاق ملف TXT'}
        <input type="file" accept=".txt,text/plain" disabled={busy||loadingFile} aria-label={savedFile?'استبدال ملف TXT':'إرفاق ملف TXT'} onChange={uploadFile}/>
      </label>
      <button className="button secondary" type="button" disabled={busy||loadingFile||!paste.trim()||paste===savedFile?.text} onClick={saveEdits}>حفظ نص الكشف</button>
      {savedFile&&<button className="button secondary" type="button" disabled={busy||loadingFile} onClick={removeFile}>حذف الملف المحفوظ</button>}
    </div>
    {loadingFile&&<p className="hint">جاري استرجاع كشف SAP المحفوظ…</p>}
    {savedFile&&<p className="hint">الملف المحفوظ على Supabase <b dir="auto">{savedFile.name}</b>{paste!==savedFile.text?' · عندك تعديلات غير محفوظة':''}</p>}
    {fileError&&<div className="banner error" role="alert">{fileError}</div>}
    <label>كشف SAP<textarea className="serial-input" dir="ltr" value={paste} disabled={busy||loadingFile} onChange={event=>{
      setPaste(event.target.value);
      onPreview([],[]);
      setGroups([]);
      setIssues([]);
      setSelected([]);setSelectedReverse([]);setSelectedForward([]);setSavedTarget(null);
      setQuery('');
      setMessage('');
    }}/></label>
    <button className="button primary" type="button" disabled={busy||loadingFile||!paste.trim()} onClick={()=>preview()}>معاينة الاستيراد</button>
    {issues.length>0&&<div className="banner error" role="alert">{issues.join(' · ')}</div>}
    {groups.length>0&&<>
      <div className="table-controls">
        <div className="search"><Search size={16}/><input type="search" aria-label="بحث في نتائج استيراد SAP" placeholder="ابحث برقم الترحيل أو الفاتورة أو الفرع" value={query} onChange={event=>{setQuery(event.target.value);setSelected([]);setSelectedReverse([]);setSelectedForward([]);setSavedTarget(null)}}/></div>
        <button className="button secondary" type="button" aria-pressed={filter==='reversal'} onClick={()=>setFilter(filter==='reversal'?'all':'reversal')}>
          {filter==='reversal'?'رجوع لمعاينة الاستيراد':'الترحيلات الملغاة ('+reversals.length+')'}
        </button>
      </div>
      {filter==='reversal'?<>
        <h2>الترحيلات الملغاة</h2>
        <p className="hint">رقم الترحيل الأصلي يُقرأ من Remarks. السطر أدناه يربط الأصل بمستند عكس الإلغاء.</p>
        <div className="table-controls"><button className="button primary" type="button" disabled={busy||(!selectedReverse.length&&!selectedForward.length)||!!issues.length} onClick={linkSelectedForReview}>ربط المحدد وفتح للمراجعة ({selectedForward.length} جديد، {selectedReverse.length} عكسي)</button></div><div className="table-scroll"><table>
          <thead><tr><th>تحديد</th><th>مستند عكس الإلغاء</th><th>الترحيل الأصلي المقابل</th><th>تاريخ العكس</th><th>الفرع</th><th>البنود</th><th>Remarks</th><th>السجل</th></tr></thead>
          <tbody>{visibleReversals.map(group=>{
            const member=group.members[0];
            return <tr key={member.transfer.number}>
              <td>{isLinkableReverse(group)&&<input className="sap-import-check" type="checkbox" aria-label={'تحديد ترحيل عكسي '+member.transfer.number} checked={selectedReverse.includes(keyOf(group))} disabled={busy||!!issues.length} onChange={event=>setSelectedReverse(previous=>event.target.checked?[...previous,keyOf(group)]:previous.filter(item=>item!==keyOf(group)))}/>}</td><td><code>{member.transfer.number}</code></td>
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
          <option value="all">كل المجموعات ({groups.length-reversals.length})</option>
          <option value="ready">جاهزة للحفظ ({ready.length})</option>
          <option value="saved">مسجّلة سابقًا</option>
          <option value="review">بحاجة لمراجعة</option>
        </select>
        <button className="button secondary" type="button" disabled={busy||!shownReady.length||!!issues.length} onClick={()=>setSelected(shownReady.map(keyOf))}>تحديد المجموعات الجاهزة الظاهرة</button>
        <button className="button primary" type="button" disabled={busy||!selectedGroups.length||!!issues.length||!!selectedReverse.length||!!selectedForward.length||!!savedTarget} onClick={saveSelected}>حفظ المحدد ({selectedGroups.length})</button>
        <button className="button secondary" type="button" disabled={busy||(!selectedReverse.length&&!selectedForward.length)||!!issues.length} onClick={linkSelectedForReview}>ربط المحدد وفتح للمراجعة ({selectedForward.length} جديد، {selectedReverse.length} عكسي)</button>
      </div>
      {hiddenSelected>0&&<p className="hint">المحدد يشمل {hiddenSelected} مجموعة خارج النتائج الظاهرة.</p>}
      <p className="hint">تغيير نص البحث يلغي التحديد السابق حتى لا تربط ترحيلات مخفية بالخطأ. المحدد الآن: {selected.length+(savedTarget?1:0)} مجموعة و{selectedForward.length} ترحيل جديد و{selectedReverse.length} ترحيل عكسي.</p>
      <p className="hint">للربط: حدد مجموعة فواتير واحدة، ثم حدد الترحيلات العكسية المطلوبة واضغط «ربط المحدد وفتح للمراجعة». بعدها احفظ المجموعة من شاشة المطابقة.</p>
      <p className="hint">الحفظ يسجّل الترحيلات كغير مستلمة ورقيًا. إذا رقم الفاتورة ناقص، بتقدر تضيفه لما توصلك الورقة. إذا ظهر أكثر من رقم فاتورة، وزّع البنود بينها حسب الورق بعد فتح المجموعة.</p>
      {message&&<p role="status">{message}</p>}
      <div className="table-scroll"><table>
        <thead><tr><th>تحديد</th><th>الترحيلات</th><th>الفرع</th><th>الفواتير الزرقاء</th><th>البنود</th><th>الحالة</th><th>فتح</th></tr></thead>
        <tbody>{shown.map(group=>{
          const key=keyOf(group);
          return <tr key={key}>
            <td>{isReady(group)?<input className="sap-import-check" type="checkbox" aria-label={'تحديد مجموعة '+key} checked={selected.includes(key)} disabled={busy||!!issues.length} onChange={event=>{setSavedTarget(null);setSelected(previous=>event.target.checked?[...previous,key]:previous.filter(item=>item!==key))}}/>:group.members.some(member=>member.reverseMovement)?<input className="sap-import-check" type="checkbox" aria-label={'تحديد ترحيل عكسي '+key} title={isLinkableReverse(group)?'تحديد الترحيل العكسي':reverseProblem(group)} checked={selectedReverse.includes(key)} disabled={busy||!!issues.length||!isLinkableReverse(group)} onChange={event=>setSelectedReverse(previous=>event.target.checked?[...previous,key]:previous.filter(item=>item!==key))}/>:null}</td>
            <td>{group.members.map(item=>{
              const already=recordedTransferNumbers.has(documentNo(item.transfer.number));
              return <div key={item.transfer.number}>{group.savedIds.length&&!item.reverseMovement&&!item.reversal&&!item.issues.length&&!already&&<label><input className="sap-import-check" type="checkbox" aria-label={'تحديد ترحيل جديد '+item.transfer.number} checked={selectedForward.includes(item.transfer.number)} disabled={busy} onChange={event=>setSelectedForward(previous=>event.target.checked?[...previous,item.transfer.number]:previous.filter(number=>number!==item.transfer.number))}/>ترحيل جديد للإضافة</label>}<details><summary><code>{item.transfer.number}</code></summary><p dir="auto">{item.remarks||'بدون Remarks'}</p></details></div>;
            })}</td>
            <td>{group.draft.branch||group.members[0].branchLabel||'—'}</td>
            <td dir="ltr">{group.draft.invoices.map(invoice=>invoice.number).filter(Boolean).join('، ')||'—'}</td>
            <td>{group.members.reduce((count,item)=>count+item.lineCount,0)}</td>
            <td>{group.allTransfersSaved?'مسجّلة':group.savedIds.length?'مرتبطة بسجل سابق؛ راجع المجموعة قبل إضافة ترحيل جديد':group.issues.join('، ')||(group.draft.invoices.some(invoice=>!invoice.number)?'جاهزة للحفظ · رقم الفاتورة ناقص':'جاهزة للحفظ')}
              {group.members.some(member=>member.reverseMovement)&&!isLinkableReverse(group)&&<p className="red">تعذّر تحديد العكسي: {reverseProblem(group)}</p>}{errors[key]&&<p className="red">{errors[key]}</p>}</td>
            <td>{group.savedIds.map((id,index)=>{
              const record=previewRecords.find(entry=>entry.id===id);
              const stored=record?JSON.parse(record.payload) as Draft:undefined;
              return <div key={id}>{!group.reversal&&!group.members.some(member=>member.reverseMovement)&&<label><input type="radio" name="saved-target-group" checked={savedTarget?.id===id&&savedTarget.key===key} disabled={busy} onChange={()=>{setSelected([]);setSavedTarget({key,id})}}/>اختيار المحفوظ {index+1} للربط · ترحيلات {(stored?.transfers||[]).map(t=>t.number).join('، ')||'—'}</label>}<button type="button" className="button secondary small" disabled={busy} onClick={()=>openSaved(id)}>فتح المحفوظ {index+1}</button></div>;
            })}
              {!group.savedIds.length&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>openDraft(group.draft)}>فتح للمراجعة</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!shown.length&&<p className="hint">{search?'ما في مجموعات بتطابق البحث والفلتر.':'ما في مجموعات بهالحالة.'}</p>}
      </>}
    </>}
  </details>{notification&&<div className="modal-backdrop notification-backdrop"><section className="modal panel notification-dialog" role="alertdialog" aria-modal="true" aria-label={notification.error?'تنبيه':'إشعار'}><h2>{notification.error?'تنبيه':'إشعار'}</h2><p>{notification.text}</p><div className="notification-actions"><button type="button" className="button primary" onClick={()=>setNotification(null)}>حسنًا</button></div></section></div>}</>;
}
