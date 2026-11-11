'use client';
import {useMemo,useState} from 'react';
import {AlertTriangle,CheckCircle2,Download,FileSpreadsheet,RefreshCw,Upload} from 'lucide-react';
import {evaluateSerial,serialReviewNote,type SerialReport,type SerialRecord,type SerialRow} from '../lib/serial-soldier';

const label={received:'واصل ومطابق',pending:'ورقه غير مؤكدة',missing:'غير واصل',review:'تحتاج مراجعة'};
const color={received:'#d8f3dc',pending:'#fad5e5',missing:'#fad5e5',review:'#fff0bf'};
async function getSaved():Promise<SerialRecord[]> {
 const response=await fetch('/api/reconcile?export=1',{cache:'no-store'});
 const data:any=await response.json();
 if(!response.ok||!Array.isArray(data.records))throw Error(data.error||'تعذر قراءة السجلات المحفوظة.');
 return data.records;
}
export default function SerialSoldier(){
 const [file,setFile]=useState<File|null>(null);
 const [buffer,setBuffer]=useState<ArrayBuffer|null>(null);
 const [report,setReport]=useState<SerialReport|null>(null);
 const [issues,setIssues]=useState<string[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [day,setDay]=useState('');
 const [updated,setUpdated]=useState('');
 const daily=useMemo(()=>{
   const map=new Map<string,{total:number;received:number;pending:number;missing:number;review:number}>();
   for(const row of report?.rows||[]){
     const date=row.date||'تاريخ غير معروف';
     const result=map.get(date)||{total:0,received:0,pending:0,missing:0,review:0};
     result.total++;result[row.state]++;map.set(date,result);
   }
   return [...map].sort(([a],[b])=>a.localeCompare(b));
 },[report]);
 const filtered=(report?.rows||[]).filter(row=>!day||row.date===day);
 async function checkExcel(nextFile:File){
   setFile(nextFile);setReport(null);setBuffer(null);setIssues([]);setError('');setDay('');setBusy(true);
   try{
     if(!/\.xlsx$/i.test(nextFile.name))throw Error('ارفع ملف Excel بصيغة XLSX فقط.');
     const content=await nextFile.arrayBuffer();
     const {readSerialWorkbook}=await import('../lib/serial-workbook');
     const parsed=readSerialWorkbook(content);
     setIssues(parsed.errors);
     const saved=await getSaved();
     const result=evaluateSerial(parsed.rows,saved);
     result.blockers=[...new Set([...parsed.errors,...result.blockers])];
     setReport(result);setBuffer(content);setUpdated(new Date().toLocaleString('ar-JO'));
   }catch(e){setError(e instanceof Error?e.message:'تعذر تحليل الملف.');}
   finally{setBusy(false);}
 }
 async function refresh(){
   if(!file)return;
   await checkExcel(file);
 }
 async function download(){
   if(!buffer||!file||!report||busy)return;
   setBusy(true);setError('');
   try{
     const {readSerialWorkbook,createSerialWorkbook}=await import('../lib/serial-workbook');
     const parsed=readSerialWorkbook(buffer);
     setIssues(parsed.errors);
     const saved=await getSaved();
     const fresh=evaluateSerial(parsed.rows,saved);
     fresh.blockers=[...new Set([...parsed.errors,...fresh.blockers])];
     setReport(fresh);
     // A review copy is always available for a readable XLSX; validation issues stay visible.
     const blob=createSerialWorkbook(buffer,fresh);
     const url=URL.createObjectURL(blob),a=document.createElement('a');
     a.href=url;
     a.download=file.name.replace(/\.xlsx$/i,'')+'-جندي-السيريل.xlsx';
     a.click();
     setTimeout(()=>URL.revokeObjectURL(url),1200);
     setUpdated(new Date().toLocaleString('ar-JO'));
   }catch(e){setError(e instanceof Error?e.message:'تعذر إنشاء Excel.');}
   finally{setBusy(false);}
 }
 return <div>
   <div className="page-title">
     <div><p className="eyebrow">جندي المطابقة</p><h1>جندي السيريل – فواتير المؤسسة</h1><p>ارفع ملف سجى، وافحص وصول الفواتير ومبالغها وترحيلاتها، واسترجع الملف بنفس التصميم مع التلوين وأرقام الترحيلات.</p></div>
   </div>
   <section className="panel no-print">
     <h2><FileSpreadsheet size={21} style={{verticalAlign:'middle',marginLeft:8}}/>كشف سجى الأصلي</h2>
     <p className="hint">المصدر المعتمد: الشيت «للطباعة»؛ رقم الفاتورة D، المبلغ F، ترحيلات رئيسي K ونواشف L، والتعديلات M وما بعدها. تبقى أرقام سجى ومبالغها الأصلية كما هي. عند وجود اختلاف فقط، يظهر رقمك أو مبلغك الصحيح في ملاحظة بجانب الصف المعني، دون تعديل قاعدة المشروع.</p>
     <label style={{display:'block',marginBottom:14}}>اختيار Excel سجى (.xlsx)
       <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void checkExcel(f);e.target.value='';}}/>
     </label>
     <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
       <button type="button" className="button secondary" onClick={()=>void refresh()} disabled={!file||busy}><RefreshCw size={16}/>إعادة الفحص من السجل الحالي</button>
       <button type="button" className="button primary" onClick={()=>void download()} disabled={!buffer||!report||busy}><Download size={17}/>تنزيل ملف سجى ملوّنًا مع أرقام الترحيلات</button>
     </div>
     <p className="hint">التنزيل متاح حتى بوجود أخطاء مطابقة؛ النسخة للمراجعة وليست اعتمادًا نهائيًا. لا توجد أعمدة مقارنة مكررة أو شيت مراجعة جديد؛ الملاحظات تظهر فقط في صفوف الاختلاف أو عدم التأكيد. المجموعات القديمة المعتمدة لا تُشترط لها صفحات ولا تُنسب ترحيلاتها عشوائيًا لفاتورة منفردة.</p>
     {file&&<p className="hint">الملف: <b>{file.name}</b> {updated?'· آخر مطابقة: '+updated:''}{busy?' · جارٍ التحقق…':''}</p>}
     {error&&<p role="alert" className="red"><AlertTriangle size={16} style={{verticalAlign:'middle'}}/> {error}</p>}
     {issues.length>0&&<div role="alert" className="review-list"><strong>سطور Excel غير سليمة:</strong>{issues.map((issue,i)=><p key={i}>{issue}</p>)}</div>}
   </section>
   {report&&<>
     <section className="panel">
       <div className="section-title"><CheckCircle2 size={20}/><div><h2>نتيجة الفحص</h2><p>التصنيف يراجع الرقم والمبلغ وحالة التأكيد في السجل؛ الترحيـلات تؤخذ من حركات المستودعات الفعلية، مع اعتماد المطابقة المحفوظة للسجلات القديمة.</p></div></div>
       <div className="stats">
         <div className="stat"><span>جميع فواتير سجى</span><strong>{report.rows.length}</strong></div>
         <div className="stat"><span>واصل ومطابق</span><strong>{report.count.received}</strong></div>
         <div className="stat"><span>غير واصل / ورق غير مؤكد</span><strong>{report.count.missing+report.count.pending}</strong></div>
         <div className="stat"><span>تحتاج مراجعة</span><strong>{report.count.review}</strong></div>
       </div>
       {report.blockers.length>0&&<div role="alert" className="review-list" style={{marginTop:15}}>
         <h3><AlertTriangle size={18} style={{verticalAlign:'middle'}}/> {report.blockers.length} أخطاء تحتاج مراجعة — التنزيل متاح</h3>
         <p>الملف الناتج نسخة للمراجعة مع جميع الفروقات. لا تتحول الأخطاء إلى مطابقة معتمدة، ولا يتم تعديل البيانات المحفوظة. سجلات الفواتير القديمة المطابقة مستثناة من شرط الصفحات فقط.</p>
         <div style={{maxHeight:260,overflowY:'auto'}}>{report.blockers.map((b,i)=><p key={i}>{b}</p>)}</div>
       </div>}
       {report.legacyWarnings.length>0&&<details className="review-list" style={{marginTop:14}}><summary>ترحيلات مجموعات قديمة معتمدة دون اشتراط أرقام الصفحات ({report.legacyWarnings.length})</summary><div style={{maxHeight:240,overflowY:'auto'}}>{report.legacyWarnings.map((item,i)=><p key={i}>{item}</p>)}</div></details>}
       {report.count.review>0&&<p className="amber">الفواتير ذات فروقات المبالغ أو الأرقام أو حالة المطابقة غير المعتمدة تُظلل بالأصفر ولا تُحتسب واصلة مطابقة. يمكنك تنزيل نسخة مراجعة في جميع الأحوال.</p>}
     </section>
     <section className="panel">
       <h2>ملخص فواتير كل يوم</h2>
       <div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>الإجمالي</th><th>واصل ومطابق</th><th>غير واصل</th><th>غير مؤكد</th><th>مراجعة</th></tr></thead>
       <tbody>{daily.map(([date,c])=><tr key={date}><td dir="ltr">{date}</td><td>{c.total}</td><td>{c.received}</td><td>{c.missing}</td><td>{c.pending}</td><td>{c.review}</td></tr>)}</tbody></table></div>
     </section>
     <section className="panel">
       <div className="table-controls"><h2>تفاصيل الفواتير</h2>
         <label>فلترة حسب اليوم <select aria-label="تصفية فواتير جندي السيريل حسب التاريخ" value={day} onChange={e=>setDay(e.target.value)}><option value="">كل الأيام</option>{daily.map(([date])=><option key={date} value={date}>{date}</option>)}</select></label>
       </div>
       <p className="hint">يُعرض أول 200 صف هنا لتسهيل التصفح، بينما يشمل ملف التصدير جميع الفواتير من دون استثناء.</p>
       <div className="table-scroll"><table><thead><tr><th>صف Excel</th><th>رقم الفاتورة</th><th>مبلغ سجى</th><th>الحالة</th><th>رئيسي 001→011</th><th>نواشف 002→011</th><th>تعديلات / عكسي</th><th>ملاحظات</th></tr></thead>
       <tbody>{filtered.slice(0,200).map((item:SerialRow)=>{
         const cols=[...item.transfers.filter(x=>x.kind==='main'),...item.transfers.filter(x=>x.kind==='dry')];
         const adjustments=item.transfers.filter(x=>x.kind==='adjustment');
         return <tr key={item.row} style={{backgroundColor:color[item.state]}}>
           <td>{item.row}</td><td dir="ltr">{item.number||'—'}</td><td dir="ltr">{item.amount||'—'}</td><td>{label[item.state]}</td>
           <td dir="ltr">{cols.filter(t=>t.kind==='main').map(t=>t.number).join('، ')||'—'}</td>
           <td dir="ltr">{cols.filter(t=>t.kind==='dry').map(t=>t.number).join('، ')||'—'}</td>
           <td dir="ltr">{adjustments.map(t=>t.number).join('، ')||'—'}</td><td>{serialReviewNote(item)||'—'}</td>
         </tr>;
       })}</tbody></table></div>
     </section>
   </>}
 </div>;
}
