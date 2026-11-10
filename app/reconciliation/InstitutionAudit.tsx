'use client';

import {useEffect,useMemo,useState} from 'react';
import AuditCatalogEditor from './AuditCatalogEditor';
import {catalogAuditReference,type AuditCatalog} from '../lib/audit-catalog';
import {AlertTriangle,CheckCircle2,Search,Plus,RefreshCw} from 'lucide-react';
import {auditInstitutionTransfers,auditInvoiceQuantities} from '../lib/institution-audit';
import {readSavedSapImport} from '../lib/saved-sap-import';
import {parseSapImport,type SapImportGroup} from '../lib/sap-import';
import {dateValue,digits,money,type Draft,type Transfer} from '../lib/reconcile';

type StoredRecord={id:string;branch:string;payload:string};
type Choice={id:string;source:'sap'|'saved';title:string;group?:SapImportGroup;record?:StoredRecord};
const numberHits=(value:string,query:string)=>Boolean(value)&&digits(value).trim().endsWith(query);
function choiceLabel(choice:Choice){return choice.title}
const parseRow=(record:StoredRecord):Partial<Draft>=>{
  try{return JSON.parse(record.payload) as Draft}catch{return {}}
};
export default function InstitutionAudit({branches}:{branches:string[]}){
  const [catalog,setCatalog]=useState<AuditCatalog|null>(null);
  const reference=useMemo(()=>catalog?catalogAuditReference(catalog):[],[catalog]);
  const sapNames=useMemo(()=>new Map(catalog?.sap.map(row=>[row.code,row.name])),[catalog]);
  const [imports,setImports]=useState<SapImportGroup[]>([]);
  const [records,setRecords]=useState<StoredRecord[]>([]);
  const [loading,setLoading]=useState(true);
  const [fetchError,setFetchError]=useState('');
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const [transfers,setTransfers]=useState<Transfer[]>([]);
  const [title,setTitle]=useState('');
  const [inverseNo,setInverseNo]=useState('');
  const [invoiceLines,setInvoiceLines]=useState('');
  const [invoiceAmount,setInvoiceAmount]=useState('');
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Amman'});
  const [dateFrom,setDateFrom]=useState(today.slice(0,8)+'01');
  const [dateTo,setDateTo]=useState(today);
  const [dailyBusy,setDailyBusy]=useState(false);
  const [dailyError,setDailyError]=useState('');
  type DailyRow={recordId:string;branch:string;invoice:{
    id:string;number:string;date:string;amount:number|null;expected:number|null;
    status:'match'|'review'|'difference';reasons:string[];transferNumbers:string[];
    quantityDifferences:number;missingPaperLines:boolean;
  }};
  const [daily,setDaily]=useState<{from:string;to:string;days:number;unreadableRecords:number;rows:DailyRow[];counts:{
    total:number;matched:number;differences:number;review:number;
  }}|null>(null);

  async function scanRange(){
    const from=dateValue(dateFrom),to=dateValue(dateTo);
    if(!from||!to){setDailyError('اختر تاريخ البداية والنهاية بشكل صحيح.');setDaily(null);return}
    if(from>to){setDailyError('تاريخ البداية يجب أن يكون قبل تاريخ النهاية.');setDaily(null);return}
    if((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000>365){
      setDailyError('أقصى مدة للتدقيق سنة واحدة.');setDaily(null);return;
    }
    setDailyBusy(true);setDailyError('');setDaily(null);
    try{
      const params=new URLSearchParams({soldierDateFrom:from,soldierDateTo:to});
      const response=await fetch('/api/reconcile?'+params.toString(),{cache:'no-store'});
      const result=await response.json() as {error?:string;from:string;to:string;days:number;
        unreadableRecords:number;rows:DailyRow[];
        counts:{total:number;matched:number;differences:number;review:number}};
      if(!response.ok)throw Error(result.error||'تعذّر فحص فواتير الفترة المطلوبة.');
      setDaily(result);
    }catch(e){setDailyError(e instanceof Error?e.message:'تعذّر فحص الفواتير ضمن الفترة.')}
    finally{setDailyBusy(false)}
  }

  async function refresh(){
    setLoading(true);setFetchError('');
    try{
      const [sap,registry]=await Promise.allSettled([
        readSavedSapImport(),
        fetch('/api/reconcile?records=1',{cache:'no-store'}).then(async response=>{
          const result=await response.json() as {error?:string;records?:StoredRecord[]};
          if(!response.ok)throw Error(result.error||'تعذرت قراءة السجل');
          if(!Array.isArray(result.records))throw Error('رد سجل المطابقات غير صالح.');
          return result.records;
        })
      ]);
      if(sap.status==='fulfilled'&&sap.value?.text){
        const result=parseSapImport(sap.value.text,branches);
        setImports(result.groups);
        if(result.issues.length)setFetchError('يوجد سطور تحتاج مراجعة في ملف SAP: '+result.issues[0]);
      }else{
        setImports([]);
        setFetchError('كشف SAP المحفوظ غير متاح. لا يمكن التحقق من ترحيلات غير موجودة بالسجل.');
      }
      if(registry.status==='fulfilled')setRecords(registry.value);
      else setFetchError(old=>old+' تعذّر جلب سجل المطابقات.');
    }finally{setLoading(false)}
  }
  useEffect(()=>{if(branches.length)void refresh().catch(e=>{setFetchError(e instanceof Error?e.message:'تعذّر جلب البيانات');setLoading(false)})},[branches]);

  const choices=useMemo(()=>{
    const query=digits(search).trim();
    if(query.length<4||!/^[0-9]+$/.test(query))return [] as Choice[];
    const out:Choice[]=[];
    for(const [index,group] of imports.entries()){
      const transfers=group.members.map(row=>row.transfer.number);
      const invoices=[...new Set(group.members.flatMap(row=>row.invoices))];
      if(![...transfers,...invoices].some(value=>numberHits(value,query)))continue;
      out.push({id:'sap-'+index,source:'sap',title:'SAP · '+(group.draft.branch||'فرع غير محدد')+' · ترحيلات '+transfers.join('، ')+' · فواتير '+(invoices.join('، ')||'بلا رقم'),group});
    }
    for(const record of records){
      const saved=parseRow(record);
      const transfers=(saved.transfers||[]).map(row=>row.number);
      const invoices=(saved.invoices||[]).map(row=>row.number);
      if(![...transfers,...invoices].some(value=>numberHits(value,query)))continue;
      out.push({id:'saved-'+record.id,source:'saved',title:'السجل · '+record.branch+' · ترحيلات '+transfers.join('، ')+' · فواتير '+invoices.filter(Boolean).join('، '),record});
    }
    return out.slice(0,70);
  },[search,imports,records]);

  async function choose(choice:Choice){
    setError('');
    try{
      if(choice.source==='sap'&&choice.group){
        setTransfers(choice.group.draft.transfers);
      }else if(choice.record){
        const response=await fetch('/api/reconcile?id='+encodeURIComponent(choice.record.id),{cache:'no-store'});
        const data=await response.json() as {error?:string;record?:StoredRecord};
        if(!response.ok)throw Error(data.error||'تعذّر تحميل الترحيل');
        if(!data.record)throw Error('بيانات الترحيل غير متاحة');
        const draft=JSON.parse(data.record.payload) as Draft;
        setTransfers(draft.transfers);
      }else throw Error('المستند غير متاح');
      setInvoiceLines('');setInvoiceAmount('');setTitle(choiceLabel(choice));setInverseNo('');
    }catch(e){setError(e instanceof Error?e.message:'تعذّر فتح المستند')}
  }
  function addInverse(){
    setError('');
    const number=digits(inverseNo).trim();
    if(!/^\d{4,20}$/.test(number)){setError('أدخل رقم الترحيل العكسي كاملًا.');return}
    if(transfers.some(row=>row.number===number)){setError('هذا الترحيل مضاف بالفعل.');return}
    const member=imports.flatMap(group=>group.members).find(row=>row.transfer.number===number);
    if(!member){setError('الترحيل العكسي غير موجود بملف TXT المحفوظ؛ حدّث الملف من شاشة استيراد SAP أولًا.');return}
    if(!member.reverseMovement){setError('هذا الرقم ليس ترحيلًا عكسيًا من المستودع 011؛ تحقق من الحركة.');return}
    if(member.issues.length){setError('الترحيل العكسي فيه مشكلات قراءة ويحتاج مراجعة في SAP.');return}
    setTransfers(old=>[...old,member.transfer]);
    setInverseNo('');
  }

  const scope=useMemo(()=>auditInstitutionTransfers(transfers,reference),[transfers,reference]);
  const quantity=useMemo(()=>auditInvoiceQuantities(transfers,reference,invoiceLines,invoiceAmount),[transfers,reference,invoiceLines,invoiceAmount]);
  const hasLines=!!invoiceLines.trim();
  const hasAmount=!!invoiceAmount.trim();
  const allValid=transfers.length>0&&scope.valid&&hasLines&&hasAmount&&quantity.status==='match'&&quantity.expectedTotal!==null&&quantity.amountDifference===0;
  const problems=[
    ...scope.issues.map(issue=>issue.message),
    ...quantity.issues,
    ...quantity.rows.filter(row=>Math.abs(row.difference)>0.000001).map(row=>
      row.code+' — '+row.institutionName+' · SAP '+row.sapPieces+' حبة · الفاتورة '+row.invoicePieces+' حبة · الفرق '+row.difference),
  ];
  return <div dir="rtl">
    <div className="page-title"><div><p className="eyebrow">رقابة مستقلة · لا تغيّر المطابقة اليدوية</p>
      <h1>جندي تدقيق أصناف المؤسسة</h1>
      <p>راجع الأصناف ووحدات SAP والشدّات، وقارن كميات الحبات مع الفاتورة الزرقاء. الترحيل الخاطئ يظل ظاهرًا حتى تثبت حركته العكسية.</p></div>
      <button className="button secondary" disabled={loading} type="button" onClick={()=>void refresh()}><RefreshCw size={16}/>تحديث مصادر SAP</button>
    </div>
    <section className="panel no-print">
      <div className="section-title"><h2>فحص فواتير المؤسسة حسب الفترة الزمنية</h2></div>
      <p className="hint">حدد من تاريخ إلى تاريخ حسب تاريخ الفاتورة الزرقاء، وليس تاريخ الترحيل. الجندي يراجع جميع الفواتير المحفوظة في هذه الفترة، ويطابق رقم المادة والكمية بالحبة والشدّة والقيمة لكل فاتورة مع ترحيلاتها. الفواتير الناقصة تظهر «بحاجة مراجعة»، ولا تُعتمد لمجرد تطابق المبلغ.</p>
      <div className="form-grid">
        <label>من تاريخ الفاتورة الزرقاء
          <input type="date" dir="ltr" value={dateFrom} max={dateTo}
            onChange={e=>{setDateFrom(e.target.value);setDaily(null);setDailyError('')}}/>
        </label>
        <label>إلى تاريخ الفاتورة الزرقاء
          <input type="date" dir="ltr" value={dateTo} min={dateFrom}
            onChange={e=>{setDateTo(e.target.value);setDaily(null);setDailyError('')}}/>
        </label>
        <div style={{alignSelf:'end'}}><button type="button" className="button primary"
          disabled={dailyBusy||!catalog} onClick={()=>void scanRange()}>
          <Search size={16}/>{dailyBusy?'جاري فحص الفترة…':'فحص جميع فواتير الفترة'}
        </button></div>
      </div>
      {dailyError&&<p role="alert" className="banner danger">{dailyError}</p>}
      {daily&&<><p className="hint">نتائج الفحص من <b>{daily.from}</b> إلى <b>{daily.to}</b> (شامل يوم البداية والنهاية) · {daily.days} يوم</p>
        <div className="stats">
          <div className="stat"><span>عدد الفواتير</span><strong>{daily.counts.total}</strong></div>
          <div className="stat"><span>اجتازت الجندي</span><strong>{daily.counts.matched}</strong></div>
          <div className="stat"><span>فيها فروقات</span><strong>{daily.counts.differences}</strong></div>
          <div className="stat"><span>تحتاج مراجعة</span><strong>{daily.counts.review}</strong></div>
        </div>
        {daily.unreadableRecords>0&&<p role="alert" className="banner danger">
          <AlertTriangle size={16}/> يوجد {daily.unreadableRecords} سجل غير قابل للفحص؛ لم يتم تجاهله باعتباره مطابقًا.
        </p>}
        {daily.rows.length>0?<div className="table-scroll"><table>
          <thead><tr><th>رقم الفاتورة</th><th>الفرع</th><th>التاريخ</th><th>الترحيلات المرتبطة</th><th>المبلغ</th><th>قيمة SAP</th><th>حالة الجندي</th><th>التفاصيل</th></tr></thead>
          <tbody>{daily.rows.map(row=><tr key={row.recordId+'-'+row.invoice.id}>
            <td><b>{row.invoice.number||'بلا رقم'}</b></td><td>{row.branch}</td><td>{row.invoice.date}</td>
            <td>{row.invoice.transferNumbers.join('، ')||'بحاجة لتحديد الصفحة'}</td>
            <td>{money(row.invoice.amount)}</td><td>{money(row.invoice.expected)}</td>
            <td>{row.invoice.status==='match'?'مطابق بعد تدقيق الجندي':row.invoice.status==='difference'?'فرق':'بحاجة مراجعة'}</td>
            <td>{row.invoice.reasons.length>0?<details><summary>{row.invoice.reasons.length} ملاحظات</summary>
              {row.invoice.reasons.map((reason,index)=><p key={index} className="hint">{reason}</p>)}</details>:'كل الفحوصات ناجحة'}
              <button type="button" className="button secondary small" onClick={()=>void choose({
                id:'saved-'+row.recordId,source:'saved',title:'السجل · '+row.branch+' · فاتورة '+row.invoice.number,
                record:{id:row.recordId,branch:row.branch,payload:''}
              })}>فتح الترحيلات</button></td>
          </tr>)}</tbody></table></div>
          :<p className="hint">لا توجد فواتير زرقاء مسجلة من {daily.from} إلى {daily.to} في السجل. الفحص يشمل الفواتير المحفوظة فقط.</p>}
      </>}
    </section>
    <AuditCatalogEditor onCatalog={setCatalog}/>
    {catalog&&<section className="panel">
      <div className="section-title"><Search size={19}/><h2>اختيار فاتورة أو ترحيل</h2></div>
      <label>رقم الفاتورة الزرقاء أو الترحيل (آخر 4 أرقام أو الرقم الكامل)
        <input dir="ltr" inputMode="numeric" value={search} onChange={e=>setSearch(e.target.value)} placeholder="مثال: 5834"/></label>
      {loading&&<p className="hint">جاري قراءة TXT المحفوظ والسجل…</p>}
      {fetchError&&<p role="alert" className="amber">{fetchError}</p>}
      {!!search.trim()&&search.trim().length<4&&<p className="hint">اكتب أربع خانات على الأقل لعرض المستندات.</p>}
      {choices.length>0&&<div className="table-scroll"><table><thead><tr><th>المستند</th><th>فتح</th></tr></thead>
        <tbody>{choices.map(choice=><tr key={choice.id}><td>{choice.title}</td>
          <td><button type="button" className="button secondary small" onClick={()=>void choose(choice)}>تدقيق</button></td></tr>)}</tbody></table></div>}
      {search.trim().length>=4&&!loading&&!choices.length&&<p className="hint">لا يوجد مستند مطابق في TXT أو السجل.</p>}
      {title&&<p className="hint">المستند المختار: <b>{title}</b></p>}
    </section>}
    {catalog&&transfers.length>0&&<>
      <section className="panel">
        <div className="section-title"><h2>الترحيلات والفحص الآلي</h2></div>
        <div className="table-scroll"><table><thead><tr><th>رقم الترحيل</th><th>تاريخ الترحيل</th><th>حذف من التدقيق فقط</th></tr></thead>
        <tbody>{transfers.map((transfer,index)=><tr key={transfer.id+'-'+index}>
          <td>{transfer.number}</td><td>{transfer.date||'—'}</td>
          <td><button type="button" className="button secondary small" onClick={()=>setTransfers(old=>old.filter((_,i)=>i!==index))}>إزالة من الفحص</button></td>
        </tr>)}</tbody></table></div>
        <div className="form-grid">
          <label>إضافة رقم ترحيل عكسي من ملف TXT<input dir="ltr" inputMode="numeric" value={inverseNo}
            onChange={e=>setInverseNo(e.target.value)} placeholder="رقم ترحيل من 011 إلى 001 أو 002 أو 009"
            onKeyDown={e=>{if(e.key==='Enter')addInverse()}}/></label>
          <div style={{alignSelf:'end'}}><button type="button" className="button secondary" onClick={addInverse}><Plus size={16}/>فحص الترحيل العكسي وإضافته</button></div>
        </div>
        {error&&<p role="alert" className="banner danger"><AlertTriangle size={16}/>{error}</p>}
        <div className="stats"><div className="stat"><span>بنود SAP المفحوصة</span><strong>{scope.reviewedLines}</strong></div>
          <div className="stat"><span>بنود معرّفة وقابلة للتحويل</span><strong>{scope.approvedLines}</strong></div>
          <div className="stat"><span>ملاحظات الترحيلات</span><strong>{scope.issues.length}</strong></div></div>
        {scope.resolved.length>0&&<details open><summary>حركات خارج المؤسسة عُكست بالكامل ({scope.resolved.length})</summary>
          {scope.resolved.map((row,index)=><p key={index} className="hint">{row.code} — {row.quantity} {row.unit} · الترحيلات {row.transferNumbers.join('، ')}</p>)}</details>}
      </section>
      <section className="panel">
        <div className="section-title"><h2>مطابقة الفاتورة الزرقاء بالحبة</h2></div>
        <p className="hint">الصق من الفاتورة الزرقاء عمودين: رقم المادة بالمؤسسة وكمية الحبات. لو المستند يحتوي أكثر من فاتورة، الصق مجموع بنود الفواتير المرتبطة. لا يتم اعتماد تطابق الأصناف من مبلغ الفاتورة وحده.</p>
        <label>رقم المادة بالمؤسسة ثم الكمية بالحبة<textarea dir="ltr" rows={7} value={invoiceLines}
          onChange={e=>setInvoiceLines(e.target.value)} placeholder={'رقم المادة\tالكمية\n11371486\t24\n11064245\t12'}/></label>
        <label>مجموع مبالغ الفواتير الزرقاء (دينار)<input dir="ltr" inputMode="decimal" value={invoiceAmount}
          onChange={e=>setInvoiceAmount(e.target.value)} placeholder="0.000"/></label>
        <div className="stats">
          <div className="stat"><span>مبلغ الفاتورة</span><strong>{money(quantity.invoiceTotal)} د.أ</strong></div>
          <div className="stat"><span>قيمة SAP بأسعار المؤسسة</span><strong>{money(quantity.expectedTotal)} د.أ</strong></div>
          <div className="stat"><span>فرق القيمة</span><strong>{money(quantity.amountDifference)} د.أ</strong></div>
          <div className={'stat status-stat '+(allValid?'match':'review')}><span>الحالة</span>
            <strong>{allValid?'مطابقة كاملة':!hasLines?'بانتظار بنود الفاتورة':!hasAmount?'بانتظار مبلغ الفاتورة':'بحاجة مراجعة'}</strong></div>
        </div>
        {quantity.rows.length>0&&<div className="table-scroll"><table><thead><tr>
          <th>رقم مادة المؤسسة</th><th>اسم المادة بالمؤسسة</th><th>الصنف في SAP</th><th>كمية SAP بالحبة</th><th>كمية الفاتورة بالحبة</th><th>الفرق</th>
        </tr></thead><tbody>{quantity.rows.map(row=><tr key={row.code} className={Math.abs(row.difference)>0.000001?'difference':'match'}>
          <td>{row.code}</td><td>{row.institutionName}</td><td>{row.sapCodes.map(code=>code+' · '+(sapNames.get(code)||'')).join('، ')||'—'}</td>
          <td>{row.sapPieces}</td><td>{row.invoicePieces}</td><td>{row.difference}</td>
        </tr>)}</tbody></table></div>}
        {problems.length>0&&<div className="review-list" role="alert"><b>تنبيهات التدقيق ({problems.length})</b>
          {problems.map((message,index)=><p key={index}><AlertTriangle size={14}/> {message}</p>)}</div>}
        {allValid&&<p role="status" className="banner info"><CheckCircle2 size={17}/>المبلغ، وأرقام مواد المؤسسة، والكميات بالحبة، ونطاق الترحيلات كلها متطابقة.</p>}
        <p className="hint">التدقيق مستقل ولا يحذف الأصناف من كشفك اليدوي ولا يعدّل الترحيلات أو المخزون في SAP.</p>
      </section>
    </>}
  </div>;
}
