'use client';

import {useEffect,useMemo,useState} from 'react';
import {Download,RefreshCw,Search} from 'lucide-react';
import {parseLieutenantTransfers} from '../lib/lieutenant';
import {analyzeLieutenantMovements} from '../lib/lieutenant-counterparts';
import {auditInvoicesForDay,type DayInvoiceData,type DayInvoiceState} from '../lib/lieutenant-invoice-day';
import type {Item} from '../lib/reconcile';
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
  const [view,setView]=useState<'net'|'invoices'>('net');
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
        <div className="form-grid no-print">
          <label>نوع العرض
            <select aria-label="نوع عرض صافي الترحيلات" value={view} onChange={e=>setView(e.target.value as 'net'|'invoices')}>
              <option value="net">صافي الترحيلات فقط</option>
              <option value="invoices">مقارنة الترحيلات بالفواتير الزرقاء</option>
            </select>
          </label>
        </div>
        {view==='invoices'?
          <InvoiceComparison file={file!} selectedFrom={selectedFrom} selectedTo={selectedTo} invalidRange={invalidRange}/>:
          <>
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
          </>
        }
      </>}
    </section>
  </>;
}

type InvoiceComparisonData=DayInvoiceData&{reference:Item[]};
const invoiceStates:Record<DayInvoiceState,string>={
  match:'مطابقة حسب الاعتماد / البيانات المتاحة',
  late:'مطابقة — ترحيل متأخر',
  pending:'بانتظار الترحيل',
  short:'نقص كمية مثبت',
  extra:'زيادة كمية مثبتة',
  review:'تحتاج مراجعة البيانات',
  'cashvan-settled':'كاش فان — مسوّى بعكسي/إلغاء',
  'cashvan-pending':'كاش فان — العكسي/الإلغاء غير مكتمل',
};

function InvoiceComparison({file,selectedFrom,selectedTo,invalidRange}:{
  file:SavedSapImport;selectedFrom:string;selectedTo:string;invalidRange:boolean;
}){
  const [invoiceFrom,setInvoiceFrom]=useState('');
  const [invoiceTo,setInvoiceTo]=useState('');
  const [data,setData]=useState<InvoiceComparisonData|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const from=invoiceFrom||selectedFrom.slice(0,8)+'01';
  const to=invoiceTo||selectedTo;
  const invalidInvoiceRange=!from||!to||from>to;
  const scan=useMemo(()=>parseLieutenantTransfers(file.text,[]),[file.text]);
  const report=useMemo(()=>data?
    auditInvoicesForDay(data,scan.transfers,selectedTo,data.reference||[]):null,
    [data,scan,selectedTo]);
  const movement=useMemo(()=>analyzeLieutenantMovements(scan.transfers,selectedTo),
    [scan,selectedTo]);
  const incoming=scan.transfers.filter(row=>
    row.transfer.date>=selectedFrom&&row.transfer.date<=selectedTo&&
    !row.reverse&&!row.signedAdjustment&&!row.issues.length&&
    movement.get(row.transfer.number)?.kind==='normal');
  const linked=new Set(report?.rows.flatMap(row=>row.transferNumbers)||[]);
  const notLinked=report?incoming.filter(row=>!linked.has(row.transfer.number)):[];
  const counts:Record<DayInvoiceState,number>={match:0,late:0,pending:0,short:0,extra:0,review:0,
    'cashvan-settled':0,'cashvan-pending':0};
  for(const row of report?.rows||[])counts[row.state]++;
  useEffect(()=>{setData(null);setError('');},[file,selectedFrom,selectedTo,from,to]);

  async function compare(){
    if(invalidRange||invalidInvoiceRange)return;
    setLoading(true);setError('');setData(null);
    try{
      const url='/api/reconcile?stockInvoiceFrom='+encodeURIComponent(from)+
        '&stockInvoiceTo='+encodeURIComponent(to);
      const response=await fetch(url,{cache:'no-store'});
      const result=await response.json() as InvoiceComparisonData&{error?:string};
      if(!response.ok||!Array.isArray(result.rows)||!Array.isArray(result.records)||
        !Array.isArray(result.reference))throw Error(result.error||
        'استجابة قاعدة الفواتير غير مكتملة؛ تحقق من نشر تحديث السيرفر.');
      setData(result);
    }catch(cause){setError(cause instanceof Error?cause.message:'تعذّر تحميل الفواتير الزرقاء.');}
    finally{setLoading(false)}
  }
  return <section aria-label="مقارنة الترحيلات بالفواتير الزرقاء">
    <h2>مقارنة الترحيلات بالفواتير الزرقاء</h2>
    <p className="hint">فترة الترحيلات المحددة أعلاه حسب تاريخ SAP. فترة الفواتير مستقلة لأن الفاتورة قد تصدر قبل ترحيلها بأيام. يطابق الفحص الأصناف والكميات بحسب الربط والشدّات المعتمدة، ويُظهر البيانات غير المثبتة للمراجعة.</p>
    <div className="form-grid">
      <label>الفواتير الزرقاء من تاريخ
        <input type="date" value={from} onChange={event=>setInvoiceFrom(event.target.value)}/>
      </label>
      <label>الفواتير الزرقاء إلى تاريخ
        <input type="date" value={to} onChange={event=>setInvoiceTo(event.target.value)}/>
      </label>
      <div className="save-actions">
        <button type="button" className="button primary" disabled={loading||invalidRange||invalidInvoiceRange}
          onClick={()=>void compare()}><Search size={16}/>
          {loading?'جارٍ فحص الفواتير…':'فحص الترحيلات مع الفواتير'}
        </button>
      </div>
    </div>
    {invalidInvoiceRange&&<p className="banner error" role="alert">فترة الفواتير غير صالحة. اختر تاريخ بداية لا يتجاوز النهاية.</p>}
    {error&&<p className="banner error" role="alert">{error}</p>}
    {!!scan.issues.length&&<p className="banner warn">ملف SAP فيه {scan.issues.length} ملاحظة قراءة؛ نتائج المقارنة قد تكون غير مكتملة.</p>}
    {!data&&!loading&&!error&&<p className="hint">اختر فترة الفواتير واضغط فحص. لا تُعدّل هذه العملية الفواتير أو اعتمادها.</p>}
    {data&&report&&<>
      <div className="stats">
        <div className="stat"><span>فواتير الفترة</span><strong>{report.rows.filter(row=>!row.cashVan).length}</strong></div>
        <div className="stat"><span>كاش فان مسوّى</span><strong>{counts['cashvan-settled']}</strong></div>
        <div className="stat"><span>كاش فان بحاجة تسوية</span><strong>{counts['cashvan-pending']}</strong></div>
        <div className="stat"><span>مطابقة أو معتمدة</span><strong>{counts.match+counts.late}</strong></div>
        <div className="stat"><span>نقص أو زيادة مثبتة</span><strong>{counts.short+counts.extra}</strong></div>
        <div className="stat"><span>بانتظار الترحيل</span><strong>{counts.pending}</strong></div>
        <div className="stat"><span>تحتاج مراجعة</span><strong>{counts.review}</strong></div>
        <div className="stat"><span>ترحيلات وارد غير مرتبطة بفواتير الفترة</span><strong>{notLinked.length}</strong></div>
      </div>
      {data.unreadableRecords>0&&<p className="banner warn">يوجد {data.unreadableRecords} سجل فاتورة غير قابل للقراءة؛ لم يُفترض أنه غير موجود.</p>}
      {data.undatedInvoices>0&&<p className="banner warn">يوجد {data.undatedInvoices} فاتورة بدون تاريخ مثبت؛ قد تكون خارج المقارنة الحالية.</p>}
      {data.inferredDates>0&&<p className="hint">تاريخ {data.inferredDates} فاتورة مستنتج من تاريخ SAP، وليس مثبتًا يدويًا.</p>}
      {report.sourceLastDate<selectedTo&&<p className="banner warn">أحدث حركة في كشف SAP بتاريخ {report.sourceLastDate||'غير معروف'}، وهو أقدم من تاريخ نهاية الفحص {selectedTo}؛ لا يُثبت غياب ترحيلات بعده.</p>}
      {report.rows.length?<div className="table-scroll"><table>
        <thead><tr>
          <th>الفاتورة الزرقاء</th><th>الفرع</th><th>تاريخ الفاتورة</th>
          <th>ترحيلات SAP المرتبطة</th><th>حالة المطابقة</th><th>تفاصيل الأصناف والفرق</th>
        </tr></thead>
        <tbody>{report.rows.map((row,index)=><tr key={row.recordId+'|'+row.number+'|'+index}>
          <td dir="ltr"><b>{row.cashVan?'كاش فان — بلا فاتورة زرقاء':row.number||'غير مثبت'}</b></td><td>{row.branch}</td>
          <td dir="ltr">{row.invoiceDate}</td>
          <td dir="ltr">{row.transferNumbers.join('، ')||'غير مثبت'}</td>
          <td><span className={'badge '+(row.state==='match'||row.state==='late'||row.state==='cashvan-settled'?'match':
            row.state==='short'||row.state==='extra'?'difference':'review')}>
            {invoiceStates[row.state]}
            {row.cashVan&&!!row.reverseNumbers?.length&&
              <small style={{display:'block'}}>رقم العكسي: {row.reverseNumbers.join('، ')}</small>}
          </span></td>
          <td><details><summary>{row.cashVan?'عرض تسوية الكاش فان':'عرض الأصناف ('+row.items.length+')'}</summary>
            {!!row.notes.length&&<ul>{row.notes.map((note,i)=><li key={i}>{note}</li>)}</ul>}
            {!!row.items.length&&<table><thead><tr>
              <th>رقم صنف المؤسسة</th><th>اسم الصنف</th>
              <th>الفاتورة (حبة)</th><th>المرحل (حبة)</th><th>الفرق (فاتورة − SAP)</th>
            </tr></thead><tbody>{row.items.map(item=><tr key={item.code}>
              <td dir="ltr">{item.code}</td><td>{item.name}</td>
              <td dir="ltr">{item.expected===null?'—':formatQuantity.format(item.expected)}</td>
              <td dir="ltr">{item.posted===null?'—':formatQuantity.format(item.posted)}</td>
              <td dir="ltr">{item.difference===null?'—':formatQuantity.format(item.difference)}</td>
            </tr>)}</tbody></table>}
          </details></td>
        </tr>)}</tbody>
      </table></div>:<p className="hint">لا توجد فواتير مؤرخة في الفترة المختارة ضمن السجلات المقروءة.</p>}
      <details className="lieutenant-stock-details">
        <summary>الترحيلات الواردة إلى 011 غير المرتبطة بفواتير الفترة ({notLinked.length})</summary>
        <p className="hint">هذه الترحيلات غير مرتبطة بالفواتير المؤرخة داخل النطاق المحدد فقط. قد تتبع فاتورة خارج الفترة أو تكون مرتبطة بسجل غير مكتمل؛ ليست فروقات كميات مثبتة.</p>
        {notLinked.length?<div className="table-scroll"><table>
          <thead><tr><th>رقم الترحيل</th><th>تاريخ SAP</th><th>عدد السطور</th><th>الملاحظات</th></tr></thead>
          <tbody>{notLinked.map(row=><tr key={row.transfer.number}>
            <td dir="ltr">{row.transfer.number}</td><td dir="ltr">{row.transfer.date}</td>
            <td>{row.lineCount}</td><td>{row.remarks||'لم يثبت الربط بفواتير الفترة'}</td>
          </tr>)}</tbody>
        </table></div>:<p>كل ترحيلات الوارد المؤهلة في فترة SAP لها رابط ضمن الفواتير المحددة.</p>}
      </details>
      <p className="hint">الشرطة (—) تعني كمية غير مثبتة وليست صفرًا. الفواتير المعتمدة ماليًا تبقى معتمدة بحسب قرارك، لكن عدم توفر توزيع الأصناف لا يتحول إلى تطابق كمي مفترض. الإلغاء والعكسي والكاش فان تُفحص بحالاتها الخاصة ولا تُعامل كترحيل توريد يحتاج فاتورة.</p>
    </>}
  </section>;
}
