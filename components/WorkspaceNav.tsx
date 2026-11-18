'use client';
import {Plus,ClipboardList,Settings,ClipboardCheck,History,CalendarDays,BookOpen,Zap,ShieldCheck,RefreshCw,PackageCheck,HeartPulse,Landmark,FileText,Calculator,Archive,FileCheck2,ArrowLeftRight} from 'lucide-react';

export default function WorkspaceNav({area,tab,onSelect}:{area:'exchanges'|'reconciliation';tab:string;onSelect:(tab:string)=>void}){
const groups=[
 {label:'مساحة العمل',items:[
  ['exchanges','new','تسجيل بدل',Plus],
  ['exchanges','history','سجل البدلات',ClipboardList],
  ['exchanges','catalog','الأصناف وربط SAP',Settings],
 ]},
 {label:'مراجعة المؤسسة',items:[
  ['reconciliation','sap-files','ملفات SAP',PackageCheck],
  ['reconciliation','work','مطابقة فواتير المؤسسة',ClipboardCheck],
  ['reconciliation','instant','مطابقة فورية',Zap],
  ['reconciliation','replace','استبدال الأصناف والشدّات',RefreshCw],
  ['reconciliation','history','سجل المطابقات',History],
  ['reconciliation','invoices','سجل فواتير المؤسسة',ClipboardList],
  ['reconciliation','reassurance','طمني',HeartPulse],
  ['reconciliation','colonel','العقيد — القيادة والرقابة',Landmark],
 ]},
 {label:'الملازم أول — رقابة 011',items:[
  ['reconciliation','lieutenant','تدقيق الترحيلات',ShieldCheck],
  ['reconciliation','lieutenant-day','فحص يوم الفواتير الزرقاء',CalendarDays],
  ['reconciliation','lieutenant-balance','مطابقة رصيد 011',Calculator],
  ['reconciliation','lieutenant-opening','الأرصدة الافتتاحية',BookOpen],
  ['reconciliation','lieutenant-query','كويري وأرشيف الرصيد',Archive],
  ['reconciliation','lieutenant-cashvan','الكاش فان والترحيلات العكسية',ArrowLeftRight],
  ['reconciliation','lieutenant-cancellations','قرارات الإلغاء',FileCheck2],
 ]},
 {label:'مؤسسة العقبة — المطابقة',items:[
  ['reconciliation','aqaba','إدخال فواتير العقبة',ClipboardCheck],
  ['reconciliation','aqaba-prices','مرجع أسعار العقبة',BookOpen],
  ['reconciliation','aqaba-stock','حركات مخزون العقبة',PackageCheck],
  ['reconciliation','aqaba-documents','المستندات الرسمية',FileText],
  ['reconciliation','aqaba-queries','كويريات العقبة',Calculator],
 ]},
 {label:'التقارير والمراجع',items:[
  ['reconciliation','serial-soldier','جندي السيريل – فواتير المؤسسة',ShieldCheck],
  ['reconciliation','monthly','مطابقة ترحيلات M2026',CalendarDays],
  ['reconciliation','stock','صافي الترحيلات إلى 011',PackageCheck],
  ['reconciliation','reference','مرجع أصناف المطابقة',BookOpen],
 ]},
];
return <nav className="workspace-nav" aria-label="مساحة عمل المؤسسة">{groups.filter(group=>area!=='reconciliation'||group.label!=='مساحة العمل').map(group=>
  <div key={group.label}>
   <div className="workspace-label">{group.label}</div>
   {group.items.map(([itemArea,key,label,Icon]:any)=>{
    const active=area===itemArea&&tab===key;
    return itemArea===area?<button key={key} className={active?'workspace-link active':'workspace-link'}
      aria-current={active?'page':undefined} onClick={()=>onSelect(key)}><Icon size={17}/>{label}</button>:
      <a key={key} className="workspace-link" href={(itemArea==='exchanges'?'/':'/reconciliation')+'?view='+key}><Icon size={17}/>{label}</a>;
   })}
  </div>
 )}</nav>;
}
