'use client';
import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import {readAqabaOfficial,readAqabaBlue,readAqabaTransfers,readAqabaJournal,auditAqabaJournal,compareAqaba,reviewAqabaTransfers,AQABA_CUSTOMER,
 type AqabaLine,type BlueLine,type AqabaTransfer,type AqabaMovement} from '../lib/aqaba';
import {sapReferences,money,type Item} from '../lib/reconcile';
import {defaultAqabaDates,officialAqabaQuery,transferAqabaQuery,aqabaInventoryQuery} from '../lib/aqaba-query';
import {CheckCircle2,AlertTriangle,Copy,FileText,RefreshCw,Save} from 'lucide-react';

const initial=defaultAqabaDates();
type ResponseData={official:AqabaLine[];blue:BlueLine[];transfers:AqabaTransfer[];journal:AqabaMovement[];partial?:boolean;nextOffset?:number|null};
const template=[
 'رقم الفاتورة الزرقاء\tالتاريخ\tكود SAP\tاسم الصنف\tالكمية\tالوحدة\tالسعر\tأرقام الفواتير الرسمية\tأرقام الترحيلات',
 '2650710369\t2026-11-03\tCHS00561\tجبنة فيتا جولد\t600\tPiece\t0.350\t\t2615754',
].join('\n');
async function request(body?:unknown,query=''):Promise<any>{
 const res=await fetch('/api/aqaba'+query,body?{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
 }:{cache:'no-store'});
 if(!(res.headers.get('content-type')||'').includes('application/json'))
   throw Error('خادم العقبة لم يُرجع JSON؛ تحقق من الاتصال أو جلسة الدخول.');
 const data:any=await res.json();
 if(!res.ok)throw Error(data.error||'تعذّر الاتصال بشاشة العقبة.');
 return data;
}
export default function AqabaWorkspace({catalog,onEditPrice,section='invoices'}:{catalog:Item[];onEditPrice:(sapCode:string,name:string)=>void;section?:'invoices'|'prices'|'stock'|'documents'|'queries'}){
 const [from,F]=useState(initial.from),[to,T]=useState(initial.to);
 const loadRevision=useRef(0);
 const [officialPaste,OP]=useState(''),[bluePaste,BP]=useState(''),[transferPaste,TP]=useState(''),[journalPaste,JP]=useState('');
 const [saved,S]=useState<ResponseData>({official:[],blue:[],transfers:[],journal:[]});
 const [packs,PACK]=useState<Record<string,number>>({});
 const [working,W]=useState(false),[error,E]=useState(''),[message,M]=useState(''),[partial,PART]=useState(false),[savedLoading,LOADING]=useState(true);
 const [search,Q]=useState(''),[priceSearch,PRICESEARCH]=useState('');
 const [priceBook,setPriceBook]=useState<Item[]>([]),[priceLoading,setPriceLoading]=useState(true),[priceError,setPriceError]=useState('');
 useEffect(()=>{
  let active=true;setPriceLoading(true);setPriceError('');
  fetch('/api/reconcile?aqabaPricing=1',{cache:'no-store'}).then(async response=>{
   const data=await response.json() as {reference?:Item[];error?:string};if(!response.ok||!Array.isArray(data.reference))throw Error(data.error||'تعذّر تحميل أسعار العقبة.');
   return data.reference as Item[];
  }).then(items=>{if(active)setPriceBook(items)}).catch(error=>{if(active)setPriceError(error.message)})
   .finally(()=>{if(active)setPriceLoading(false)});
  return ()=>{active=false};
 },[catalog,saved.blue]);
 const official=useMemo(()=>officialPaste.trim()?readAqabaOfficial(officialPaste):null,[officialPaste]);
 const blue=useMemo(()=>bluePaste.trim()?readAqabaBlue(bluePaste):null,[bluePaste]);
 const transfers=useMemo(()=>transferPaste.trim()?readAqabaTransfers(transferPaste):null,[transferPaste]);
 const journal=useMemo(()=>journalPaste.trim()?readAqabaJournal(journalPaste):null,[journalPaste]);
 const mergedOfficial=useMemo(()=>{
  const byKey=new Map(saved.official.map(x=>[x.key,x] as const));
  for(const row of official?.items||[])byKey.set(row.key,row);
  return [...byKey.values()];
 },[saved.official,official]);
 const mergedBlue=useMemo(()=>{
  const byKey=new Map(saved.blue.map(x=>[x.key,x] as const));
  for(const row of blue?.items||[])byKey.set(row.key,row);
  return [...byKey.values()];
 },[saved.blue,blue]);
 const mergedTransfers=useMemo(()=>{
  const byKey=new Map(saved.transfers.map(x=>[x.key,x] as const));
  for(const row of transfers?.items||[])byKey.set(row.key,row);
  return [...byKey.values()];
 },[saved.transfers,transfers]);
 const mergedJournal=useMemo(()=>{
  const byKey=new Map(saved.journal.map(x=>[x.key,x] as const));
  for(const row of journal?.items||[])byKey.set(row.key,row);
  return [...byKey.values()];
 },[saved.journal,journal]);
 const journalAudit=useMemo(()=>auditAqabaJournal(
   mergedJournal.filter(x=>x.date>=from&&x.date<=to),mergedOfficial,mergedTransfers),
   [mergedJournal,mergedOfficial,mergedTransfers,from,to]);
 const stockRows=useMemo(()=>{
  const byItem=new Map<string,{item:string;incoming:number;outgoing:number;aqabaIncoming:number;aqabaOutgoing:number}>();
  for(const row of journalAudit.rows){
    const current=byItem.get(row.item)||{item:row.item,incoming:0,outgoing:0,aqabaIncoming:0,aqabaOutgoing:0};
    current.incoming+=row.incoming;current.outgoing+=row.outgoing;
    if(row.assigned==='aqaba-evidence'){
      current.aqabaIncoming+=row.incoming;current.aqabaOutgoing+=row.outgoing;
    }
    byItem.set(row.item,current);
  }
  return [...byItem.values()].sort((a,b)=>a.item.localeCompare(b.item));
 },[journalAudit.rows]);
 const priceReference=useMemo(()=>{
  const latest=new Map<string,BlueLine>();
  for(const row of saved.blue){
    const previous=latest.get(row.item);
    if(!previous||row.date>previous.date||(row.date===previous.date&&row.invoice>previous.invoice))latest.set(row.item,row);
  }
  const catalogBySap=new Map(sapReferences(catalog).map(item=>[item.sapCode,item]));
  return priceBook.map(item=>({item,row:latest.get(item.sapCode),manual:catalogBySap.get(item.sapCode)?.aqabaPrices?.[item.sapCode]}))
   .filter(({item,row})=>(item.sapCode+' '+item.name+' '+(row?.invoice||'')).toLowerCase().includes(priceSearch.toLowerCase().trim()));
 },[saved.blue,priceSearch,priceBook,catalog]);
 const results=useMemo(()=>compareAqaba(mergedBlue,mergedOfficial),[mergedBlue,mergedOfficial]);
 const triplets=useMemo(()=>reviewAqabaTransfers(mergedBlue,mergedTransfers,packs),[mergedBlue,mergedTransfers,packs]);
 const invoices=useMemo(()=>{
  const by=new Map<string,AqabaLine[]>();
  for(const line of mergedOfficial){
   const key=line.kind+'|'+line.document;
   const lines=by.get(key)||[];lines.push(line);by.set(key,lines);
  }
  return [...by].map(([key,lines])=>({key,lines,first:lines[0],
   amount:lines.reduce((sum,row)=>sum+row.lineTotal+row.tax,0)}))
   .filter(x=>x.key.includes(search)||x.lines.some(y=>y.item.includes(search)))
   .sort((a,b)=>b.first.date.localeCompare(a.first.date)||b.first.document.localeCompare(a.first.document,'en',{numeric:true}));
 },[mergedOfficial,search]);
 const [expanded,EXP]=useState('');
 const load=async()=>{
  if(!from||!to||from>to)return;
  const revision=++loadRevision.current;
  LOADING(true);
  try{
   const all:ResponseData={official:[],blue:[],transfers:[],journal:[],partial:false};
   let offset=0,complete=false;
   for(let page=0;page<200;page++){
    const data=await request(undefined,'?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to)+'&offset='+offset) as ResponseData;
    all.official.push(...data.official);all.blue.push(...data.blue);
    all.transfers.push(...data.transfers);all.journal.push(...data.journal);
    if(!data.partial){complete=true;break;}
    const next=data.nextOffset;
    if(typeof next!=='number'||!Number.isSafeInteger(next)||next<=offset)throw Error('تعذّر استكمال صفحات العقبة. لن تُعتمد بيانات جزئية.');
    offset=next;
   }
   if(!complete)throw Error('عدد صفحات العقبة يتجاوز حد الفحص. ضيّق الفترة حتى يمكن التحقق من جميع المستندات.');
   if(revision===loadRevision.current){S(all);PART(false)}
  }catch(error){if(revision===loadRevision.current)throw error;
  }finally{if(revision===loadRevision.current)LOADING(false)}
 };
 useEffect(()=>{load().catch(e=>E(e.message))},[from,to]);
 useEffect(()=>{
  fetch('/api/reconcile',{cache:'no-store'}).then(async res=>{
   if(!res.ok)throw Error('المرجع غير متاح');
   return res.json();
  }).then((data:any)=>{
   const seen:Record<string,number>={};
   for(const item of data.reference||[]){
    for(const def of [item,...(item.sapAliases||[])]){
     const pack=Number(def.cartonPieces);
     if(/^[A-Z]{2,6}\d{3,10}$/.test(def.sapCode)&&Number.isInteger(pack)&&pack>0){
       if(seen[def.sapCode]!==undefined&&seen[def.sapCode]!==pack)delete seen[def.sapCode];
       else seen[def.sapCode]=pack;
     }
    }
   }
   PACK(seen);
  }).catch(()=>{});
 },[]);
 const copy=async(type:'official'|'transfer'|'inventory')=>{
  try{
   const query=type==='official'?officialAqabaQuery(from,to):type==='transfer'?transferAqabaQuery(from,to):aqabaInventoryQuery(from,to);
   await navigator.clipboard.writeText(query);M('تم نسخ كويري SAP.');
  }catch(e){E('تعذّر نسخ الكويري تلقائيًا. '+(e instanceof Error?e.message:''))}
 };
 const save=async(type:'official'|'blue'|'transfer'|'inventory')=>{
  const read=type==='official'?official:type==='blue'?blue:type==='transfer'?transfers:journal;
  if(!read?.items.length){E('لا توجد سطور صالحة للحفظ.');return}
  if(read.issues.length&&!window.confirm('هناك '+read.issues.length+' ملاحظة قراءة. هل تريد حفظ البنود الصالحة فقط مع مراجعة الملاحظات؟'))return;
  W(true);E('');M('');
  try{
   let added=0,updated=0,unchanged=0;
   for(let i=0;i<read.items.length;i+=50){
    const out=await request({action:type==='official'?'aqabaOfficial':type==='blue'?'aqabaBlue':type==='transfer'?'aqabaTransfer':'aqabaJournal',
      items:read.items.slice(i,i+50)});
    added+=out.added;updated+=out.updated;unchanged+=out.unchanged;
   }
   await load();M('حُفظت البيانات: '+added+' جديد، '+updated+' تحديث، '+unchanged+' دون تغيير.');
  }catch(e){E((e instanceof Error?e.message:String(e))+' — قد تكون دفعات سابقة حُفظت؛ حدّث السجل قبل إعادة اللصق.')}
  finally{W(false)}
 };
 const matched=partial?0:results.filter(x=>!x.differences.length&&!x.issues.length).length;
 return <div dir="rtl" className="aqaba-workspace">
  <div className="page-title"><div><p className="eyebrow">الزبون {AQABA_CUSTOMER} · المستودع 011</p>
   <h1>{({invoices:'مؤسسة العقبة — الفواتير والمطابقة',prices:'مرجع أسعار العقبة',stock:'حركات مخزون العقبة',documents:'المستندات الرسمية للعقبة',queries:'كويريات SAP للعقبة'} as const)[section]}</h1><p>من 01/11/2026؛ فصل كامل عن بيانات مؤسسة عمّان. لا يُعتبر أي مستند سببًا لخصم المخزون ما لم تثبته حركات SAP.</p></div>
   <button type="button" className="button secondary" onClick={()=>{E('');void load().then(()=>M('تم تحديث سجل العقبة.')).catch(e=>E(e.message))}}><RefreshCw size={16}/>تحديث السجل</button>
  </div>
  {error&&<div className="banner error" role="alert">{error}</div>}
  {partial&&<div className="banner error" role="alert">عدد سطور SAP يتجاوز حد العرض في هذه الفترة. النتائج جزئية؛ ضيّق الفترة ولا تعتمد المطابقة قبل تحميل جميع المستندات.</div>}
  {message&&<div className="banner info" role="status">{message}</div>}
   {section==='queries'&&<>
  <section className="panel">
   <div className="section-title"><FileText size={20}/><div><h2>كويريات SAP للعقبة</h2>
    <p>غيّر الفترة ثم انسخ كويري الفواتير أو الترحيلات. كليهما يظهر الإلغاءات ولا يستبعدها.</p></div></div>
   <div className="form-grid">
    <label>من تاريخ<input type="date" min="2026-11-01" value={from} onChange={e=>F(e.target.value)}/></label>
    <label>إلى تاريخ<input type="date" min="2026-11-01" value={to} onChange={e=>T(e.target.value)}/></label>
    <button className="button secondary" type="button" onClick={()=>copy('official')}><Copy size={16}/>نسخ كويري الفواتير والإلغاءات</button>
    <button className="button secondary" type="button" onClick={()=>copy('transfer')}><Copy size={16}/>نسخ كويري ترحيلات 011</button>
    <button className="button secondary" type="button" onClick={()=>copy('inventory')}><Copy size={16}/>نسخ كويري OINM لحركة 011 الفعلية</button>
   </div>
   <p className="hint">كويري الفواتير يشمل IN وCN وDN وRE بحالات N وY وC، وكويري الترحيلات يشمل كل دخول وخروج من 011. لا تحذف المستند الملغي؛ نحتاجه لتفسير المقابل. الترحيل لا يُصنّف للعقبة إلا إذا ثبت من Remarks أو من الربط اليدوي.</p>
  </section>
   </>}


   {section==='invoices'&&<>
  <section className="panel">
   <div className="section-title"><FileText size={20}/><div><h2>لصق الفواتير الزرقاء وأسعار العقبة</h2>
    <p>ألصق بنود الزرقاء بالأعمدة المطلوبة؛ سعر العقبة يُحفظ مع الفاتورة والتاريخ ولا يغير أسعار مؤسسة عمّان.</p></div></div>
   <details><summary>مثال تنسيق اللصق (بالعناوين) — للأصناف الجديدة أو التصحيح فقط</summary><pre dir="ltr" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{template}</pre></details>
   <textarea dir="ltr" style={{minHeight:155,width:'100%'}} aria-label="بنود الفواتير الزرقاء للعقبة" placeholder="رقم الفاتورة الزرقاء، التاريخ، كود SAP، الكمية، الوحدة، السعر، الفاتورة الرسمية، الترحيلات — مفصولة بـ Tab" value={bluePaste} onChange={e=>BP(e.target.value)}/>
   <p className="hint" role="status">{savedLoading?'جاري قراءة البنود المحفوظة من قاعدة بيانات العقبة…':
    <>المحفوظ فعلًا بقاعدة بيانات العقبة ضمن الفترة المختارة: <b>{saved.blue.length} بند</b> ضمن <b>{new Set(saved.blue.map(row=>row.invoice)).size} فواتير زرقاء</b>. خانة اللصق للإضافة أو التصحيح فقط ولا يلزم إعادة إدخال الأصناف المحفوظة.</>}</p>
   {!savedLoading&&saved.blue.length===0&&<p className="red" role="alert">لا توجد بنود زرقاء محفوظة ظاهرة لهذه الفترة. تحقق أن الفترة تشمل 03/11/2026 وأن تحديث المشروع منشور على الموقع، ثم اضغط «تحديث السجل».</p>}
   <div className="row-actions"><span>في خانة اللصق الآن: {blue?.items.length||0} بند جديد أو معدل · {blue?.issues.length||0} ملاحظات</span>
    <button type="button" className="button primary" disabled={working||!blue?.items.length} onClick={()=>save('blue')}><Save size={16}/>حفظ الزرقاء وأسعارها</button></div>
   {!!blue?.issues.length&&<details><summary>ملاحظات قراءة الزرقاء</summary>{blue.issues.slice(0,80).map((e,i)=><p key={i} className="red">{e}</p>)}</details>}
  </section>
   </>}
   {section==='prices'&&<>
  <section className="panel" aria-label="مرجع أسعار العقبة">
   <div className="section-title"><FileText size={20}/><div>
     <h2>مرجع أسعار العقبة — السعر المعتمد للمطابقة</h2>
     <p>عدّل سعر الحبة مباشرة من زر «تعديل سعر العقبة». يظهر السعر المحفوظ من الربط هنا وتستخدمه مطابقة العقبة.</p>
   </div></div>
   <div className="form-grid"><label>البحث عن صنف أو فاتورة
     <input type="search" value={priceSearch} onChange={e=>PRICESEARCH(e.target.value)} placeholder="كود SAP أو رقم الفاتورة"/>
   </label></div>
   <p className="hint">الأسعار بالدينار لكل حبة. سعر العقبة مستقل عن سعر المؤسسة، وتعديله هنا لا يغيّر بنود الفواتير الأصلية.</p>
   {priceError&&<p className="red" role="alert">{priceError}</p>}
   {priceError?null:priceLoading?<p role="status">جاري تحميل الأسعار المعتمدة…</p>:!priceReference.length?<p className="hint">لا توجد أصناف مطابقة للبحث.</p>:
   <div style={{overflowX:'auto',maxHeight:420,overflowY:'auto'}}><table>
     <thead><tr><th>كود SAP</th><th>الصنف</th><th>سعر الحبة بالدينار</th><th>الفاتورة المرجعية</th><th>تاريخ السعر</th><th>المصدر</th><th/></tr></thead>
     <tbody>{priceReference.map(({item,row,manual})=><tr key={item.sapCode}><td dir="ltr">{item.sapCode}</td>
       <td>{item.name}</td><td>{money(item.price)}</td>
       <td>{row?.invoice||'—'}</td><td>{manual?.updatedAt.slice(0,10)||row?.date||'—'}</td>
       <td>{manual?'تعديلك المحفوظ':item.price===null?'لم يُسجل سعر بعد':row?.sourceFile?'Excel — 03/11/2026':'الفواتير الزرقاء'}</td>
       <td><button type="button" className="button secondary small" onClick={()=>onEditPrice(item.sapCode,item.name)}>
         {item.price===null?'إضافة سعر العقبة':'تعديل سعر العقبة'}
       </button></td>
     </tr>)}</tbody>
   </table></div>}

  </section>
   </>}
   {section==='invoices'&&<>
  <section className="panel">
   <div className="section-title"><CheckCircle2 size={20}/><div><h2>مراجعة الربط والمطابقة الجزئية</h2>
    <p>نتيجة الزرقاء ↔ الفواتير الرسمية فقط؛ الترحيلات وOINM لا تزال تحتاج فحصًا مستقلًا. اختلاف الوحدة يظل فرقًا حتى تثبت الشدّة.</p></div></div>
   <div className="stats"><div className="stat"><span>فواتير رسمية</span><strong>{new Set(mergedOfficial.filter(x=>x.kind==='IN').map(x=>x.document)).size}</strong></div>
    <div className="stat"><span>فواتير زرقاء</span><strong>{new Set(mergedBlue.map(x=>x.invoice)).size}</strong></div>
    <div className="stat"><span>زرقاء دون فروق رسمية مثبتة</span><strong>{matched}</strong></div>
    <div className="stat"><span>مستندات الترحيل</span><strong>{new Set(mergedTransfers.map(x=>x.document)).size}</strong></div></div>
   {!results.length?<p className="hint">لا توجد فواتير زرقاء محفوظة بعد. الصق الفواتير أولًا ثم أربط أرقام الفواتير الرسمية.</p>:<div style={{overflowX:'auto'}}><table><thead><tr><th>الزرقاء</th><th>الفاتورة الرسمية</th><th>الترحيلات</th><th>حالة الفحص</th><th>تفاصيل</th></tr></thead>
    <tbody>{results.map(x=><tr key={x.invoice}><td>{x.invoice}</td><td>{x.officialNumbers.join('، ')||'غير مربوط'}</td><td>{x.transferNumbers.join('، ')||'غير مربوط'}</td><td>{x.status}</td><td>{x.issues.map((v,i)=><p key={i} className="red">{v}</p>)}{x.differences.map(d=><p key={d.key}>{d.key}: الزرقاء {d.blue} / الرسمية {d.official} / الفرق {d.difference}</p>)}</td></tr>)}</tbody>
   </table></div>}
  </section>
   </>}
   {section==='invoices'&&<>
  <section className="panel">
   <div className="section-title"><AlertTriangle size={20}/><div><h2>مطابقة مجموعات الترحيل والزرقاء</h2>
    <p>إذا أكثر من فاتورة زرقاء مرتبطة بنفس الترحيل، تُجمع فواتير المجموعة قبل التدقيق. كل فرق بالوحدة يبقى ظاهرًا، ولا نعتمد حركة المخزون دون OINM.</p></div></div>
   {!triplets.length?<p className="hint">لا توجد فواتير زرقاء مرتبطة لفحص الترحيلات.</p>:
    <div style={{overflowX:'auto'}}><table><thead><tr><th>الفواتير الزرقاء</th><th>ترحيلات SAP</th><th>النتيجة</th><th>فروقات / ملاحظات</th></tr></thead>
     <tbody>{triplets.map((t,i)=><tr key={i}><td>{t.blueInvoices.join('، ')}</td><td>{t.transferNumbers.join('، ')||'غير مربوط'}</td><td>{t.state==='quantity-aligned-not-stock-verified'?'الكميات متساوية مبدئيًا؛ بانتظار OINM':t.differences.length?'فرق كميات':'بحاجة مراجعة'}</td>
      <td>{t.issues.map((issue,j)=><p key={j} className="red">{issue}</p>)}{t.differences.map(d=><p key={d.key}>{d.key}: الزرقاء {d.blue} / الترحيل {d.transferred} / الفرق {d.difference}</p>)}</td></tr>)}</tbody>
    </table></div>}
  </section>
   </>}
   {section==='stock'&&<>
  <section className="panel">
   <div className="section-title"><AlertTriangle size={20}/><div><h2>حركات المخزون الفعلية من OINM</h2>
    <p>ارفع كشف OINM للمستودع 011 في «ملفات SAP»، بما فيه حركات عمّان والأصناف غير المصنفة. لا نخصم AR Invoice فوق OINM مرة أخرى.</p></div></div>
   <p><a className="button secondary" href="/reconciliation?view=sap-files">ملفات SAP — رفع الفواتير والترحيلات وكشف OINM</a></p>

   <p className="hint">التقرير للفترة {from} إلى {to}، وهو صافي الحركة خلال الفترة وليس الرصيد النهائي دون افتتاحي SAP.</p>
   <p>عدد حركات OINM في الفترة: <b>{journalAudit.rows.length}</b> · حركات غير مصنفة: <b>{journalAudit.unassigned.length}</b></p>
   <p className="hint">الأرصدة والكميات تُعرض حسب كود الصنف في وحدة المخزون الخاصة به، ولا نجمع الأصناف المختلفة في رصيد واحد.</p>
   {stockRows.length>0&&<div style={{overflowX:'auto'}}><table>
     <thead><tr><th>كود SAP</th><th>وارد 011</th><th>صادر 011</th><th>صافي 011</th><th>وارد منسوب للعقبة بدليل</th><th>صادر منسوب للعقبة بدليل</th></tr></thead>
     <tbody>{stockRows.map(row=><tr key={row.item}><td>{row.item}</td>
      <td>{row.incoming.toFixed(3)}</td><td>{row.outgoing.toFixed(3)}</td>
      <td>{(row.incoming-row.outgoing).toFixed(3)}</td><td>{row.aqabaIncoming.toFixed(3)}</td><td>{row.aqabaOutgoing.toFixed(3)}</td>
     </tr>)}</tbody>
   </table></div>}
   {journalAudit.issues.map((issue,i)=><p className="amber" key={i}>{issue}</p>)}
  </section>
   </>}
   {section==='documents'&&<>
  <section className="panel">
   <div className="section-title"><AlertTriangle size={20}/><div><h2>سجل جميع المستندات الرسمية</h2>
    <p>حالات الإلغاء Y وC لا تُخفى. رقم المستند المرجعي معروض، لكن الربط لم يُثبت تلقائيًا دون بيانات SAP المقابلة.</p></div></div>
   <input type="search" placeholder="ابحث برقم المستند أو كود الصنف" aria-label="بحث مستندات العقبة" value={search} onChange={e=>Q(e.target.value)}/>
   <div style={{overflowX:'auto'}}><table><thead><tr><th>المستند</th><th>تاريخ</th><th>حالة SAP</th><th>بنود</th><th>المبلغ قبل/بعد الضريبة</th><th>مرجع</th></tr></thead>
    <tbody>{invoices.slice(0,120).map(x=><Fragment key={x.key}>
     <tr key={x.key} onClick={()=>EXP(expanded===x.key?'':x.key)} style={{cursor:'pointer'}}>
      <td>{x.first.kind} {x.first.document}</td><td>{x.first.date}</td><td>{x.first.canceled}</td>
      <td>{x.lines.length}</td><td>{x.amount.toFixed(3)}</td>
      <td>{[...new Set(x.lines.map(l=>l.baseRef).filter(Boolean))].join('، ')||'غير مثبت'}</td>
     </tr>{expanded===x.key&&<tr key={x.key+'-detail'}><td colSpan={6}><div>{x.lines.map(line=><p key={line.key} dir="auto">{line.item} · {line.description} · {line.quantity} {line.unit||'وحدة غير مذكورة'} × {line.unitPrice.toFixed(3)} — مستند مرجعي {line.baseRef||'غير مثبت'}</p>)}</div></td></tr>}
    </Fragment>)}</tbody></table></div>
   {invoices.length>120&&<p className="hint">يعرض أول 120 مستندًا؛ استخدم البحث للوصول للبقية.</p>}
  </section>
   </>}
  <p className="hint">تدقيق المخزون الفعلي يستمر من الملازم أول مع كشف OINM. الشاشة لا تعتبر أي خصم افتراضيًا ولا تمنح اعتمادًا نهائيًا بلا ترحيلات مثبتة.</p>
 </div>;
}
