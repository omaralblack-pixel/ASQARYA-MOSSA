'use client';

import {useState} from 'react';
import {Search} from 'lucide-react';
import {digits,documentNo,transferNumbers,type Draft} from '../lib/reconcile';
import {parseSapImport,type SapImportGroup} from '../lib/sap-import';

type SavedRecord={id:string;branch:string;payload:string};
type PreviewGroup=SapImportGroup&{savedIds:string[];allTransfersSaved:boolean;originalRecordId?:string};

function compareWithSaved(groups:SapImportGroup[],records:SavedRecord[]):PreviewGroup[]{
  const byTransfer=new Map<string,string>();
  const byInvoice=new Map<string,string>();
  for(const record of records){
    const draft=JSON.parse(record.payload) as Draft;
    for(const transfer of draft.transfers||[]){
      for(const number of transferNumbers(transfer.number||''))byTransfer.set(number,record.id);
    }
    for(const invoice of draft.invoices||[]){
      if(invoice.number)byInvoice.set(record.branch+'|'+documentNo(invoice.number),record.id);
    }
  }
  return groups.map(group=>{
    const transferIds=group.draft.transfers.map(transfer=>byTransfer.get(transfer.number));
    const invoiceIds=group.draft.invoices.map(invoice=>byInvoice.get(group.draft.branch+'|'+invoice.number));
    const savedIds=[...new Set([...transferIds,...invoiceIds].filter((id):id is string=>Boolean(id)))];
    const original=group.members[0].canceledTransferNo;
    return {...group,savedIds,allTransfersSaved:transferIds.every(Boolean),originalRecordId:original?byTransfer.get(original):undefined};
  });
}

const searchText=(value:string)=>digits(value).trim().toLowerCase().replace(/[أإآٱ]/g,'ا').replace(/[\u064B-\u065F\u0670ـ]/g,'');
const keyOf=(group:SapImportGroup)=>group.draft.transfers[0].number;
const isReady=(group:PreviewGroup)=>!group.reversal&&!group.issues.length&&!group.savedIds.length;

export default function SapImport({branches,readRecords,saveDraft,openDraft,openSaved,onPreview}:{
  branches:string[];
  readRecords:()=>Promise<SavedRecord[]>;
  saveDraft:(draft:Draft)=>Promise<string>;
  openDraft:(draft:Draft)=>void;
  openSaved:(id:string)=>void;
  onPreview:(groups:SapImportGroup[],records:SavedRecord[])=>void;
}){
  const [paste,setPaste]=useState('');
  const [groups,setGroups]=useState<PreviewGroup[]>([]);
  const [issues,setIssues]=useState<string[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
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

  async function preview(){
    setBusy(true);
    setMessage('');
    setGroups([]);
    onPreview([],[]);
    setSelected([]);
    setIssues([]);
    setErrors({});
    try{
      const result=parseSapImport(paste,branches);
      setIssues(result.issues);
      const records=await readRecords();
      setGroups(compareWithSaved(result.groups,records));
      onPreview(result.issues.length?[]:result.groups,records);
      setFilter('all');
      setQuery('');
    }catch(error){
      setIssues([error instanceof Error?error.message:'تعذّر تجهيز المعاينة']);
    }finally{
      setBusy(false);
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

  return <details className="panel sap-import">
    <summary>استيراد ترحيلات SAP دفعة واحدة</summary>
    <p className="hint">الصق نتيجة كويري المؤسسة مع عناوين الأعمدة. المعاينة تجمع البنود حسب الترحيل وتقرأ أرقام الفواتير من Remarks.</p>
    <label>كشف SAP<textarea className="serial-input" dir="ltr" value={paste} disabled={busy} onChange={event=>{
      setPaste(event.target.value);
      onPreview([],[]);
      setGroups([]);
      setIssues([]);
      setSelected([]);
      setQuery('');
      setMessage('');
    }}/></label>
    <button className="button primary" type="button" disabled={busy||!paste.trim()} onClick={preview}>معاينة الاستيراد</button>
    {issues.length>0&&<div className="banner error" role="alert">{issues.join(' · ')}</div>}
    {groups.length>0&&<>
      <div className="table-controls">
        <div className="search"><Search size={16}/><input type="search" aria-label="بحث في نتائج استيراد SAP" placeholder="ابحث برقم الترحيل أو الفاتورة أو الفرع" value={query} onChange={event=>setQuery(event.target.value)}/></div>
        <button className="button secondary" type="button" aria-pressed={filter==='reversal'} onClick={()=>setFilter(filter==='reversal'?'all':'reversal')}>
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
          <option value="all">كل المجموعات ({groups.length-reversals.length})</option>
          <option value="ready">جاهزة للحفظ ({ready.length})</option>
          <option value="saved">مسجّلة سابقًا</option>
          <option value="review">بحاجة لمراجعة</option>
        </select>
        <button className="button secondary" type="button" disabled={busy||!shownReady.length||!!issues.length} onClick={()=>setSelected(shownReady.map(keyOf))}>تحديد المجموعات الجاهزة الظاهرة</button>
        <button className="button primary" type="button" disabled={busy||!selectedGroups.length||!!issues.length} onClick={saveSelected}>حفظ المحدد ({selectedGroups.length})</button>
      </div>
      {hiddenSelected>0&&<p className="hint">المحدد يشمل {hiddenSelected} مجموعة خارج النتائج الظاهرة.</p>}
      <p className="hint">الحفظ يسجّل الترحيلات كغير مستلمة ورقيًا. إذا رقم الفاتورة ناقص، بتقدر تضيفه لما توصلك الورقة. إذا ظهر أكثر من رقم فاتورة، وزّع البنود بينها حسب الورق بعد فتح المجموعة.</p>
      {message&&<p role="status">{message}</p>}
      <div className="table-scroll"><table>
        <thead><tr><th>تحديد</th><th>الترحيلات</th><th>الفرع</th><th>الفواتير الزرقاء</th><th>البنود</th><th>الحالة</th><th>فتح</th></tr></thead>
        <tbody>{shown.map(group=>{
          const key=keyOf(group);
          return <tr key={key}>
            <td>{isReady(group)&&<input className="sap-import-check" type="checkbox" aria-label={'تحديد مجموعة '+key} checked={selected.includes(key)} disabled={busy||!!issues.length} onChange={event=>setSelected(previous=>event.target.checked?[...previous,key]:previous.filter(item=>item!==key))}/>}</td>
            <td>{group.members.map(item=><details key={item.transfer.number}><summary><code>{item.transfer.number}</code></summary><p dir="auto">{item.remarks||'بدون Remarks'}</p></details>)}</td>
            <td>{group.draft.branch||group.members[0].branchLabel||'—'}</td>
            <td dir="ltr">{group.draft.invoices.map(invoice=>invoice.number).filter(Boolean).join('، ')||'—'}</td>
            <td>{group.members.reduce((count,item)=>count+item.lineCount,0)}</td>
            <td>{group.allTransfersSaved?'مسجّلة':group.savedIds.length?'مرتبطة بسجل سابق؛ راجع المجموعة قبل إضافة ترحيل جديد':group.issues.join('، ')||(group.draft.invoices.some(invoice=>!invoice.number)?'جاهزة للحفظ · رقم الفاتورة ناقص':'جاهزة للحفظ')}
              {errors[key]&&<p className="red">{errors[key]}</p>}</td>
            <td>{group.savedIds.map((id,index)=><button key={id} type="button" className="button secondary small" disabled={busy} onClick={()=>openSaved(id)}>فتح المحفوظ{group.savedIds.length>1?' '+(index+1):''}</button>)}
              {!group.savedIds.length&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>openDraft(group.draft)}>فتح للمراجعة</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!shown.length&&<p className="hint">{search?'ما في مجموعات بتطابق البحث والفلتر.':'ما في مجموعات بهالحالة.'}</p>}
      </>}
    </>}
  </details>;
}
