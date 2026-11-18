'use client';
import {useEffect,useState} from 'react';
export default function DesktopSync(){
 const [devices,D]=useState<{id:string;name:string;expires:number;revoked:number}[]>([]),[name,N]=useState('كمبيوتر SAP'),[token,T]=useState(''),[error,E]=useState('');
 async function call(method='GET',id=''){
  const res=await fetch('/api/desktop-sync/devices'+(id?'?id='+encodeURIComponent(id):''),{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({name})}:{})});
  const data=await res.json() as {error?:string;devices:typeof devices;token:string};if(!res.ok)throw Error(data.error||'تعذّر الربط');return data;
 }
 const refresh=async()=>D((await call()).devices);
 useEffect(()=>{void refresh().catch(e=>E(e.message));},[]);
 return <main dir="rtl" style={{maxWidth:750,margin:'40px auto',padding:24,fontFamily:'system-ui'}}>
  <a href="/reconciliation?view=sap-files">العودة إلى ملفات SAP</a><h1>SAP Desktop Sync</h1>
  <p>أنشئ رمزًا لجهازك، ثم الصقه في البرنامج مرة واحدة. صلاحيته 90 يومًا، ويتيح أرشفة ومعالجة SAP فقط. لا يتيح تعديل الفواتير أو الإلغاءات.</p>
  <label>اسم الجهاز <input value={name} maxLength={80} onChange={e=>N(e.target.value)}/></label>{' '}
  <button onClick={()=>void call('POST').then(async data=>{T(data.token);await refresh();}).catch(e=>E(e.message))}>إنشاء رمز ربط</button>
  {token&&<section><p>انسخ الرمز الآن إلى البرنامج؛ لن يُعرض مرة ثانية. عامله مثل كلمة سر.</p><textarea readOnly dir="ltr" value={token} style={{width:'100%',height:80}}/><button onClick={()=>void navigator.clipboard.writeText(token)}>نسخ</button></section>}
  {error&&<p role="alert">{error}</p>}<ul>{devices.map(d=><li key={d.id}>{d.name} — {d.revoked?'ملغى':'ينتهي '+new Date(d.expires).toLocaleDateString('ar-JO')}{' '}<button disabled={!!d.revoked} onClick={()=>void call('DELETE',d.id).then(refresh).catch(e=>E(e.message))}>إلغاء ربط الجهاز</button></li>)}</ul>
 </main>;
}
