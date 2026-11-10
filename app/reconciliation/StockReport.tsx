'use client';

import {useEffect,useMemo,useState} from 'react';
import {Download,RefreshCw} from 'lucide-react';
import {digits} from '../lib/reconcile';
import {readSavedSapImport,type SavedSapImport} from '../lib/saved-sap-import';
import {stockHeaders,stockReport} from '../lib/stock-report';

const formatQuantity=new Intl.NumberFormat('en-US',{minimumFractionDigits:3,maximumFractionDigits:6});
const searchable=(value:string)=>digits(value).trim().toLowerCase();

export default function StockReport(){
  const [file,setFile]=useState<SavedSapImport>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const report=useMemo(()=>file?stockReport(file.text):null,[file]);
  const period=report?.from&&report.to?report.from+' — '+report.to:'';
  const query=searchable(search);
  const visible=report?.items.filter(row=>searchable(row.sapCode+' '+row.name).includes(query))??[];

  async function reload(){
    setLoading(true);
    setError('');
    try{
      setFile(await readSavedSapImport());
    }catch(err){
      setFile(undefined);
      setError(err instanceof Error?err.message:'تعذّر تحميل كشف SAP المحفوظ.');
    }finally{
      setLoading(false);
    }
  }
  useEffect(()=>{void reload()},[]);

  async function download(){
    if(!file||!report?.items.length||report.issues.length)return;
    try{
      const {tableWorkbook}=await import('../lib/invoice-workbook');
      const rows=[
        ['صافي الترحيلات إلى مستودع 011'],
        ['الفترة في كشف SAP',period],
        ['المصدر',file.name],
        ['الصافي = الوارد − العكسي + أثر الإلغاء الموقّع'],
        stockHeaders,
        ...report.items.map(row=>[row.sapCode,row.name,row.unit,row.incoming,row.reverse,row.cancellation,row.net]),
      ];
      const url=URL.createObjectURL(tableWorkbook(rows,'صافي الترحيل 011',[24,68,14,19,19,17,19],5));
      const link=document.createElement('a');
      link.href=url;
      link.download='SAP_011_Net_Transfers.xlsx';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch{
      setError('تعذّر تنزيل كشف Excel. حاول مرة ثانية.');
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
      {!loading&&report&&<>
        {period&&<p>الفترة في الملف <b dir="ltr">{period}</b> · {report.codes} كود SAP · {report.documents} مستند ترحيل</p>}
        <p className="hint">الصافي = الوارد − العكسي + أثر الإلغاء. الرقم السالب في أثر الإلغاء يخصم من الصافي، والموجب يضيف إليه.</p>
        {!!report.issues.length&&<details className="banner error">
          <summary>الكشف غير مكتمل. راجع {report.issues.length} ملاحظة قبل تنزيله.</summary>
          {report.issues.map((issue,index)=><p key={index}>{issue}</p>)}
        </details>}
        <div className="table-controls">
          <div className="search"><input type="search" aria-label="البحث في كشف الترحيلات" placeholder="ابحث بكود SAP أو اسم الصنف" value={search} onChange={e=>setSearch(e.target.value)}/></div>
          <button type="button" className="button primary" disabled={!report.items.length||!!report.issues.length} onClick={()=>void download()}><Download size={16}/>تنزيل الكشف الكامل Excel</button>
        </div>
        {visible.length>0?<div className="table-scroll"><table>
          <thead><tr>{stockHeaders.map(title=><th key={title} scope="col">{title}</th>)}</tr></thead>
          <tbody>{visible.map(row=><tr key={JSON.stringify([row.sapCode,row.unit])}>
            <td><code>{row.sapCode}</code></td><td dir="auto">{row.name||'—'}</td><td>{row.unit}</td>
            <td dir="ltr">{formatQuantity.format(row.incoming)}</td><td dir="ltr">{formatQuantity.format(row.reverse)}</td>
            <td dir="ltr">{formatQuantity.format(row.cancellation)}</td><td dir="ltr"><b>{formatQuantity.format(row.net)}</b></td>
          </tr>)}</tbody>
        </table></div>:<p>{query?'ما في أصناف تطابق البحث.':'ما في حركات إلى مستودع 011 أو منه في هذا الملف.'}</p>}
      </>}
    </section>
  </>;
}
