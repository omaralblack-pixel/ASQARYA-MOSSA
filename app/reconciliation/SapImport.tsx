'use client';

import {useState} from 'react';
import {documentNo,transferNumbers,type Draft} from '../lib/reconcile';
import {parseSapImport,type SapImportGroup} from '../lib/sap-import';

type SavedRecord={id:string;branch:string;payload:string};
type PreviewGroup=SapImportGroup&{savedIds:string[];allTransfersSaved:boolean};

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
    return {...group,savedIds,allTransfersSaved:transferIds.every(Boolean)};
  });
}

const keyOf=(group:SapImportGroup)=>group.draft.transfers[0].number;
const isReady=(group:PreviewGroup)=>!group.reversal&&!group.issues.length&&!group.savedIds.length;

export default function SapImport({branches,readRecords,saveDraft,openDraft,openSaved}:{
  branches:string[];
  readRecords:()=>Promise<SavedRecord[]>;
  saveDraft:(draft:Draft)=>Promise<string>;
  openDraft:(draft:Draft)=>void;
  openSaved:(id:string)=>void;
}){
  const [paste,setPaste]=useState('');
  const [groups,setGroups]=useState<PreviewGroup[]>([]);
  const [issues,setIssues]=useState<string[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [errors,setErrors]=useState<Record<string,string>>({});
  const [filter,setFilter]=useState('all');
  const ready=groups.filter(isReady);
  const selectedGroups=ready.filter(group=>selected.includes(keyOf(group)));
  const shown=groups.filter(group=>filter==='all'||(
    filter==='ready'?isReady(group):
    filter==='saved'?group.allTransfersSaved:
    filter==='reversal'?group.reversal:
    !group.reversal&&!isReady(group)&&!group.allTransfersSaved
  ));

  async function preview(){
    setBusy(true);
    setMessage('');
    setGroups([]);
    setSelected([]);
    setIssues([]);
    setErrors({});
    try{
      const result=parseSapImport(paste,branches);
      setIssues(result.issues);
      setGroups(compareWithSaved(result.groups,await readRecords()));
      setFilter('all');
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
      const current=compareWithSaved(selectedGroups,await readRecords());
      for(const group of current){
        const key=keyOf(group);
        try{
          if(group.savedIds.length){
            setGroups(previous=>previous.map(row=>keyOf(row)===key?group:row));
            throw Error('صار في ترحيل أو فاتورة مسجّلة. راجع المجموعة الموجودة.');
          }
          const id=await saveDraft(group.draft);
          saved++;
          setGroups(previous=>previous.map(row=>keyOf(row)===key?{...row,savedIds:[id],allTransfersSaved:true}:row));
        }catch(error){
          failed++;
          setErrors(previous=>({...previous,[key]:error instanceof Error?error.message:'تعذّر الحفظ'}));
        }
      }
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
      setGroups([]);
      setIssues([]);
      setSelected([]);
      setMessage('');
    }}/></label>
    <button className="button primary" type="button" disabled={busy||!paste.trim()} onClick={preview}>معاينة الاستيراد</button>
    {issues.length>0&&<div className="banner error" role="alert">{issues.join(' · ')}</div>}
    {groups.length>0&&<>
      <div className="table-controls">
        <select aria-label="حالة الاستيراد" value={filter} onChange={event=>setFilter(event.target.value)}>
          <option value="all">كل المجموعات ({groups.length})</option>
          <option value="ready">جاهزة للحفظ ({ready.length})</option>
          <option value="saved">مسجّلة سابقًا</option>
          <option value="review">بحاجة لمراجعة</option>
          <option value="reversal">عكس الإلغاء</option>
        </select>
        <button className="button secondary" type="button" disabled={busy||!ready.length||!!issues.length} onClick={()=>setSelected(ready.map(keyOf))}>تحديد كل المجموعات الجاهزة</button>
        <button className="button primary" type="button" disabled={busy||!selectedGroups.length||!!issues.length} onClick={saveSelected}>حفظ المحدد ({selectedGroups.length})</button>
      </div>
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
            <td>{group.reversal?'عكس إلغاء — خارج الاستيراد':group.allTransfersSaved?'مسجّلة':group.savedIds.length?'مرتبطة بسجل سابق؛ راجع المجموعة قبل إضافة ترحيل جديد':group.issues.join('، ')||(group.draft.invoices.some(invoice=>!invoice.number)?'جاهزة للحفظ · رقم الفاتورة ناقص':'جاهزة للحفظ')}
              {errors[key]&&<p className="red">{errors[key]}</p>}</td>
            <td>{group.savedIds.map((id,index)=><button key={id} type="button" className="button secondary small" disabled={busy} onClick={()=>openSaved(id)}>فتح المحفوظ{group.savedIds.length>1?' '+(index+1):''}</button>)}
              {!group.reversal&&!group.savedIds.length&&<button type="button" className="button secondary small" disabled={busy} onClick={()=>openDraft(group.draft)}>فتح للمراجعة</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!shown.length&&<p className="hint">ما في مجموعات بهالحالة.</p>}
    </>}
  </details>;
}
