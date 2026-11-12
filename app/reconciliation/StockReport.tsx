'use client';

import {useEffect,useMemo,useState} from 'react';
import {Download,RefreshCw} from 'lucide-react';
import {digits} from '../lib/reconcile';
import {readSavedSapImport,type SavedSapImport} from '../lib/saved-sap-import';
import {stockHeaders,stockReport} from '../lib/stock-report';
import {tableWorkbook} from '../lib/invoice-workbook';

const formatQuantity=new Intl.NumberFormat('en-US',{minimumFractionDigits:3,maximumFractionDigits:6});
const searchable=(value:string)=>digits(value).trim().toLowerCase();

export default function StockReport(){
  const [file,setFile]=useState<SavedSapImport>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const fileReport=useMemo(()=>file?stockReport(file.text):null,[file]);
  const selectedFrom=from||fileReport?.from||'';
  const selectedTo=to||fileReport?.to||'';
  const invalidRange=!!selectedFrom&&!!selectedTo&&selectedFrom>selectedTo;
  const report=useMemo(()=>file&&!invalidRange
    ?stockReport(file.text,{from:selectedFrom,to:selectedTo}):null,
    [file,selectedFrom,selectedTo,invalidRange]);
  const period=fileReport?.from&&fileReport.to?fileReport.from+' — '+fileReport.to:'';
  const selectedPeriod=selectedFrom&&selectedTo?selectedFrom+' — '+selectedTo:'';
  const query=searchable(search);
  const visible=report?.items.filter(row=>searchable(row.sapCode+' '+row.name).includes(query))??[];
  const cancellationOnly=report?.items.some(row=>row.cancellation!==0&&row.incoming===0&&row.reverse===0)??false;

  async function reload(){
    setLoading(true);
    setError('');
    try{
      setFile(await readSavedSapImport());
      setFrom('');
      setTo('');
    }catch(err){
      setFile(undefined);
      setError(err instanceof Error?err.message:'تعذّر تحميل كشف SAP المحفوظ.');
    }finally{
      setLoading(false);
    }
  }
  useEffect(()=>{void reload()},[]);

  async function download(){
    if(!file||invalidRange||!report?.items.length||report.issues.length)return;
    try{
      const rows=[
        ['صافي الترحيلات إلى مستودع 011'],
        ['الفترة المختارة حسب تاريخ الترحيل',selectedPeriod],
        ['الفترة في ملف SAP الأصلي',period],
        ['المصدر',file.name],
        ['مستندات الترحيل في الفترة',report.documents],
        ['الصافي = الوارد − العكسي + أثر الإلغاء الموقّع'],
        stockHeaders,
        ...report.items.map(row=>[row.sapCode,row.name,row.unit,row.incoming,row.reverse,row.cancellation,row.net]),
      ];
      const workbook=tableWorkbook(rows,'صافي الترحيل 011',[24,68,14,19,19,17,19],7);
      if(!workbook.size)throw new Error('ملف Excel الناتج فارغ.');
      const url=URL.createObjectURL(workbook);
      try{
        const link=document.createElement('a');
        link.href=url;
        link.download='SAP_011_Net_Transfers_'+selectedFrom+'_to_'+selectedTo+'.xlsx';
        document.body.appendChild(link);
        try{link.click();}finally{link.remove();}
        setError('');
      }finally{
        // Some browsers still read the object URL after the click handler returns.
        setTimeout(()=>URL.revokeObjectURL(url),30_000);
      }
    }catch(cause){
      console.error('Warehouse 011 Excel export failed',cause);
      const reason=cause instanceof Error?cause.message:'';
      setError('تعذّر تنزيل كشف Excel.'+(reason?' السبب: '+reason:' راجع إعدادات تنزيل الملفات في المتصفح.'));
    }
  }

  return <>
    <div className="page-title">
      <div><h1>صافي الترحيلات إلى 011</h1><p>حركة الأصناف من كشف SAP المحفوظ حسب كود الصنف ووحدته.</p></div>
      <button type="button" className="button secondary" onClick={()=>void reload()} disabled={loading}><RefreshCw size={16}/>تحديث الكشف</button>
    </div>
    <section className="panel">
      {loading&&<p role="status">جاري تحميل كشف SAP…</p>}
      {error&&<p className="banner error" role="alert">{error}</p>}
      {!loading&&!error&&!file&&<p>احفظ كشف TXT من «استيراد ترحيلات SAP دفعة واحدة» في شاشة مطابقة فواتير المؤسسة.</p>}
      {!loading&&fileReport&&<>
        {period&&<p>الفترة في الملف <b dir="ltr">{period}</b> · {fileReport.codes} كود SAP · {fileReport.documents} مستند ترحيل</p>}
        <div className="form-grid">
          <label>من تاريخ الترحيل
            <input type="date" value={selectedFrom} onChange={e=>setFrom(e.target.value)}/>
          </label>
          <label>إلى تاريخ الترحيل
            <input type="date" value={selectedTo} onChange={e=>setTo(e.target.value)}/>
          </label>
          <div className="save-actions">
            <button type="button" className="button secondary" onClick={()=>{setFrom('');setTo('')}} disabled={!from&&!to}>إظهار كامل فترة الملف</button>
          </div>
        </div>
        <p className="hint">التصفية حسب تاريخ مستند الترحيل في SAP، وليس تاريخ رفع الملف. تشمل حركات الوارد والعكسي والإلغاء من المستودعات وإليها، وتُحتسب بداية الفترة ونهايتها.</p>
        {invalidRange&&<p className="banner error" role="alert">تاريخ البداية بعد تاريخ النهاية. عدّل الفترة حتى يظهر صافي الترحيلات الصحيح.</p>}
        {report&&<p>الفترة المختارة <b dir="ltr">{selectedPeriod}</b> · {report.codes} كود SAP · {report.documents} مستند ترحيل</p>}
        <p className="hint">الصافي = الوارد − العكسي + أثر الإلغاء. الرقم السالب في أثر الإلغاء يخصم من الصافي، والموجب يضيف إليه.</p>
        {cancellationOnly&&<p className="hint">تنبيه: بعض أصناف الفترة فيها أثر إلغاء فقط دون وارد أو عكسي في نفس الفترة. الصافي هنا صافي حركة، وليس الرصيد الفعلي في المستودع 011؛ قد يكون أصل الحركة في تاريخ خارج الفترة المختارة.</p>}
        {!!report?.issues.length&&<details className="banner error">
          <summary>الكشف غير مكتمل. راجع {report.issues.length} ملاحظة قبل تنزيله.</summary>
          {report.issues.map((issue,index)=><p key={index}>{issue}</p>)}
        </details>}
        <div className="table-controls">
          <div className="search"><input type="search" aria-label="البحث في كشف الترحيلات" placeholder="ابحث بكود SAP أو اسم الصنف" value={search} onChange={e=>setSearch(e.target.value)}/></div>
          <button type="button" className="button primary" disabled={!report?.items.length||!!report?.issues.length||invalidRange} onClick={()=>void download()}><Download size={16}/>تنزيل كشف الفترة Excel</button>
        </div>
        {visible.length>0?<div className="table-scroll"><table>
          <thead><tr>{stockHeaders.map(title=><th key={title} scope="col">{title}</th>)}</tr></thead>
          <tbody>{visible.map(row=><tr key={JSON.stringify([row.sapCode,row.unit])}>
            <td><code>{row.sapCode}</code></td><td dir="auto">{row.name||'—'}</td><td>{row.unit}</td>
            <td dir="ltr">{formatQuantity.format(row.incoming)}</td><td dir="ltr">{formatQuantity.format(row.reverse)}</td>
            <td dir="ltr">{formatQuantity.format(row.cancellation)}</td><td dir="ltr"><b>{formatQuantity.format(row.net)}</b></td>
          </tr>)}</tbody>
        </table></div>:<p>{invalidRange?'اختر فترة تاريخ صحيحة.':query?'ما في أصناف تطابق البحث.':'ما في حركات من مستودع 011 أو إليه في الفترة المختارة.'}</p>}
      </>}
    </section>
  </>;
}
