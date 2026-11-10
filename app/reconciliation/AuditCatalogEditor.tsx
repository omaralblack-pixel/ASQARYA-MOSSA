'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import {importAuditInstitution,importAuditSap,validateAuditCatalog,type AuditCatalog} from '../lib/audit-catalog';
import {digits,fils,money,numeric} from '../lib/reconcile';

type SavedCatalog={catalog:AuditCatalog;version:string|null};
type Side=keyof AuditCatalog;
type Edit={existing?:boolean;side:Side;code:string;name:string;unit:string;pack:string;kg:string;link:string;price:string};
const blank=(side:Side):Edit=>({side,code:'',name:'',unit:'Piece',pack:'',kg:'',link:'',price:''});

export default function AuditCatalogEditor({onCatalog}:{onCatalog:(catalog:AuditCatalog)=>void}){
  const [saved,setSaved]=useState<SavedCatalog|null>(null);
  const [sap,setSap]=useState('');
  const [institution,setInstitution]=useState('');
  const [query,setQuery]=useState('');
  const [edit,setEdit]=useState<Edit|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const form=useRef<HTMLFormElement>(null);
  const editing=!!edit;
  useEffect(()=>{if(editing)form.current?.scrollIntoView({block:'nearest'})},[editing]);

  useEffect(()=>{
    let active=true;
    fetch('/api/reconcile?auditCatalog=1',{cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error('تعذّر تحميل مرجع الجندي.');
      const data:SavedCatalog=await response.json();
      if(active){setSaved(data);onCatalog(data.catalog)}
    }).catch(e=>{if(active)setError(e.message)});
    return ()=>{active=false};
  },[onCatalog]);

  async function save(update:(catalog:AuditCatalog)=>AuditCatalog, done?:()=>void){
    if(!saved||busy)return;
    setBusy(true);setError('');setNotice('');
    try{
      const catalog=update(saved.catalog);
      if(!validateAuditCatalog(catalog))throw Error('راجع الأكواد والأسماء والوحدات والشدّات.');
      const response=await fetch('/api/reconcile',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'auditCatalog',version:saved.version,catalog}),
      });
      const data=await response.json() as SavedCatalog & {error?:string};
      if(!response.ok)throw Error(data.error || 'تعذّر حفظ مرجع الجندي.');
      setSaved(data);onCatalog(data.catalog);done?.();setNotice('تم حفظ مرجع الجندي.');
    }catch(e){setError(e instanceof Error?e.message:'تعذّر الحفظ.')}
    finally{setBusy(false)}
  }

  function saveItem(event:FormEvent){
    event.preventDefault();
    if(!edit)return;
    void save(catalog=>{
      const code=digits(edit.code.trim()).toUpperCase();
      const name=edit.name.trim();
      if(!edit.existing&&catalog[edit.side].some(row=>row.code===code))throw Error('الصنف موجود. استخدم زر التعديل.');
      if(edit.side==='sap'){
        const pack=numeric(edit.pack), kg=numeric(edit.kg);
        const institutionCode=digits(edit.link.trim());
        if(edit.pack.trim()&&pack===null||edit.kg.trim()&&kg===null)throw Error('راجع الشدّة ووزن الحبة.');
        if(institutionCode&&!catalog.institution.some(row=>row.code===institutionCode))
          throw Error('أضف رقم المؤسسة إلى القائمة السفلية قبل ربطه.');
        return {...catalog,sap:[...catalog.sap.filter(row=>row.code!==code),{code,name,unit:edit.unit,pack,kg,institutionCode}]};
      }
      const price=edit.price.trim()?fils(edit.price):null;
      if(edit.price.trim()&&price===null)throw Error('راجع سعر الحبة بالدينار.');
      return {...catalog,institution:[...catalog.institution.filter(row=>row.code!==code),{code,name,price}]};
    },()=>setEdit(null));
  }

  function remove(side:Side,code:string){
    if(!window.confirm('حذف '+code+' من مرجع الجندي؟'))return;
    void save(catalog=>side==='sap'
      ? {...catalog,sap:catalog.sap.filter(row=>row.code!==code)}
      : {...catalog,institution:catalog.institution.filter(row=>row.code!==code),
        sap:catalog.sap.map(row=>row.institutionCode===code?{...row,institutionCode:''}:row)});
  }

  const catalog=saved?.catalog;
  const institutionByCode=new Map(catalog?.institution.map(row=>[row.code,row]));
  const linkedCodes=new Set(catalog?.sap.map(row=>row.institutionCode));
  const matches=(...values:string[])=>values.join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const field=(key:Exclude<keyof Edit,'existing'>,label:string)=>{
    if(!edit)return null;
    return <label>{label}<input readOnly={key==='code'&&edit.existing} value={edit[key]} onChange={e=>setEdit({...edit,[key]:e.target.value})}/></label>;
  };

  return <section className="panel">
    <div className="section-title"><h2>تعريف أصناف الجندي</h2></div>
    <p>الصق القائمتين مرة واحدة. الربط برقم مادة المؤسسة، وكمياتها تُقرأ بالحبة. الجندي يحوّل كراتين SAP حسب الشدّة وكمية KG حسب وزن الحبة.</p>
    <label>قائمة SAP وأسماؤها وشدّاتها
      <textarea dir="auto" rows={6} value={sap} onChange={e=>setSap(e.target.value)}
        placeholder={'Item No.\tItem Description\tUoM Code\tCarton Pieces\nFVL00042\tGOLDEN RIVER بطاطا بلجيكي\tCarton\t10'}/>
    </label>
    <p className="hint">الصق جدول SAP بالعناوين، أو بالترتيب التالي بدون عناوين: الكود، الاسم، الوحدة، حبات الكرتونة، وزن الحبة بالكغم، رقم المؤسسة. الأعمدة الثلاثة الأخيرة اختيارية.</p>
    <label>قائمة المؤسسة بالأسماء الرسمية
      <textarea dir="auto" rows={6} value={institution} onChange={e=>setInstitution(e.target.value)}
        placeholder={'رقم المادة بالمؤسسة\tتسمية المؤسسة\n11363842\tجولدين ريفر أصابع بطاطس 1 كغم'}/>
    </label>
    <p className="hint">الصق رقم المادة واسمها. وحدة المؤسسة ثابتة: حبة.</p>
    <button type="button" className="button primary" disabled={!catalog||busy||!sap.trim()&&!institution.trim()}
      onClick={()=>void save(current=>{
        const next=institution.trim()?importAuditInstitution(institution,current):current;
        return sap.trim()?importAuditSap(sap,next):next;
      },()=>{setSap('');setInstitution('')})}>حفظ القوائم الملصقة</button>
    {error&&<p role="alert" className="banner danger">{error}</p>}
    {notice&&<p role="status" className="banner info">{notice}</p>}
    {!catalog&&!error&&<p className="hint">جاري تحميل مرجع الجندي…</p>}
    {catalog&&<>
      <div className="form-grid">
        <label>بحث في المرجع<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="الاسم أو رقم الصنف"/></label>
        <div>
          <button className="button secondary" type="button" disabled={busy} onClick={()=>setEdit(blank('sap'))}>إضافة صنف SAP</button>{' '}
          <button className="button secondary" type="button" disabled={busy} onClick={()=>setEdit(blank('institution'))}>إضافة صنف مؤسسة</button>
        </div>
      </div>
      {edit&&<form ref={form} onSubmit={saveItem} className="panel">
        <h3>{edit.side==='sap'?'تعريف صنف SAP':'تعريف صنف المؤسسة'}</h3>
        <div className="form-grid">
          {field('code',edit.side==='sap'?'كود SAP':'رقم المؤسسة')}
          {field('name','الاسم')}
          {edit.side==='sap'?<>
            <label>وحدة SAP<select value={edit.unit} onChange={e=>setEdit({...edit,unit:e.target.value})}>
              <option>Piece</option><option>Carton</option><option>KG</option>
            </select></label>
            {field('pack','حبات الكرتونة')}{field('kg','وزن الحبة بالكغم')}{field('link','رقم مادة المؤسسة المرتبطة')}
          </>:field('price','سعر الحبة بالدينار')}
        </div>
        <button className="button primary" disabled={busy}>حفظ الصنف</button>{' '}
        <button className="button secondary" type="button" disabled={busy} onClick={()=>setEdit(null)}>إغلاق</button>
      </form>}
      <details><summary>أصناف SAP ({catalog.sap.length})</summary>
        <div className="table-scroll"><table><thead><tr>
          <th>كود SAP</th><th>اسم SAP</th><th>الوحدة</th><th>حبات الكرتونة</th><th>وزن الحبة</th><th>المؤسسة</th><th>إجراء</th>
        </tr></thead><tbody>
          {catalog.sap.filter(row=>matches(row.code,row.name,row.institutionCode,institutionByCode.get(row.institutionCode)?.name||'')).map(row=><tr key={row.code}>
            <td>{row.code}</td><td>{row.name}</td><td>{row.unit}</td><td>{row.pack??(row.unit==='Carton'?'مطلوبة':'—')}</td>
            <td>{row.kg??(row.unit==='KG'?'مطلوب':'—')}</td>
            <td>{institutionByCode.has(row.institutionCode)?row.institutionCode+' · '+institutionByCode.get(row.institutionCode)?.name:'بحاجة إلى ربط'}</td>
            <td><button type="button" className="button small secondary" disabled={busy} onClick={()=>setEdit({
              ...blank('sap'),existing:true,code:row.code,name:row.name,unit:row.unit,pack:String(row.pack??''),kg:String(row.kg??''),link:row.institutionCode,
            })}>تعديل / ربط</button>{' '}
            <button type="button" className="button small secondary" disabled={busy} onClick={()=>remove('sap',row.code)}>حذف</button></td>
          </tr>)}
        </tbody></table></div>
      </details>
      <details><summary>أصناف المؤسسة ({catalog.institution.length})</summary>
        <div className="table-scroll"><table><thead><tr><th>رقم المادة</th><th>اسم المؤسسة</th><th>الوحدة</th><th>سعر الحبة</th><th>الربط</th><th>إجراء</th></tr></thead><tbody>
          {catalog.institution.filter(row=>matches(row.code,row.name)).map(row=><tr key={row.code}>
            <td>{row.code}</td><td>{row.name}</td><td>حبة</td><td>{money(row.price)}</td><td>{linkedCodes.has(row.code)?'مرتبط':'بحاجة إلى ربط'}</td>
            <td><button type="button" className="button small secondary" disabled={busy} onClick={()=>setEdit({
              ...blank('institution'),existing:true,code:row.code,name:row.name,price:row.price===null?'':String(row.price/1000),
            })}>تعديل</button>{' '}
            <button type="button" className="button small secondary" disabled={busy} onClick={()=>remove('institution',row.code)}>حذف</button></td>
          </tr>)}
        </tbody></table></div>
      </details>
    </>}
  </section>;
}
