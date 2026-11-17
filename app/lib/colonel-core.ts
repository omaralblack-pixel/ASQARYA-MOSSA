import {dateValue,invoiceDocumentNo,readReconciliationRecord,transferNumbers} from './reconcile';
import {invoiceDate} from './invoice-collector';
import {analyzeLieutenantMovements,isCashVanTransfer} from './lieutenant-counterparts';
import type {LieutenantTransfer} from './lieutenant';
import type {CancellationDecision} from './lieutenant-cancellation-decisions';

export type ColonelRecord={id:string;branch:string;status?:string;updated?:string;payload:string};
export type ColonelAssignment={transfer_no:string;invoice_day:string;reason:string;updated_at:string};
export type ColonelDayState={day:string;invoices_complete:number;confirmed_at:string;confirmed_by:string};
export type ColonelInvoice={number:string;date:string;branch:string;amount:string;recordId:string;
  complete:boolean;dateSource:string;transfers:string[];status:string};
export type ColonelTransfer={number:string;postingDate:string;invoiceDay:string;invoiceNumbers:string[];
  branch:string;state:string;note:string;counterparts:string[];needsAction:boolean;source:'sap'|'project';
  recordIds:string[];inProject:boolean;decision:string};
export type ColonelDay={day:string;invoices:ColonelInvoice[];transfers:ColonelTransfer[];
  invoicesComplete:boolean;confirmedAt:string;openCount:number;undatedCount:number;
  ready:boolean;reason:string};
export type ColonelReport={days:ColonelDay[];unassigned:ColonelTransfer[];undated:ColonelInvoice[];
  warnings:string[];stats:{invoices:number;sapTransfers:number;open:number;unassigned:number;ready:number}};
const unique=<T>(items:T[]):T[]=>[...new Set(items)];
const knownDate=(value:string)=>dateValue(value)||'';
const cancelled=(kind:string)=>kind==='sap-canceled'||kind==='sap-cancel-doc';
const settled=(kind:string)=>cancelled(kind)||kind==='reversed'||kind==='reverse';
const correction=(kind:string)=>kind==='cancellation-review';

export function buildColonelReport(
 month:string,records:ColonelRecord[],sap:LieutenantTransfer[],
 decisions:CancellationDecision[]=[],assignments:ColonelAssignment[]=[],
 dayStates:ColonelDayState[]=[],sourceReady=false,
):ColonelReport{
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('اختر شهرًا صحيحًا.');
 const end=month+'-'+String(new Date(Date.UTC(+month.slice(0,4),+month.slice(5),0)).getUTCDate()).padStart(2,'0');
 const warnings:string[]=[],allInvoices:ColonelInvoice[]=[];
 const invoiceGroups=new Map<string,Set<string>>();
 const groupDays=new Map<string,Set<string>>();
 const fromProject=new Map<string,{records:Set<string>;invoices:Set<string>;groups:Set<string>}>();
 for(const record of records){
  const draft=readReconciliationRecord(record.payload);
  if(!draft){warnings.push('سجل مشروع غير مقروء: '+record.id);continue;}
  const ids=unique(draft.transfers.flatMap(t=>transferNumbers(t.number||'')));
  const dates=new Set<string>();
  for(const invoice of draft.invoices){
   const number=invoiceDocumentNo(invoice.number||'');
   const actual=invoiceDate(invoice,draft.transfers);
   const day=actual.date||'';
   if(day)dates.add(day);
   if(!number)warnings.push('فاتورة بلا رقم صالح في مجموعة '+record.id+'؛ الترحيلات لا تنسب لفاتورة وهمية.');
   if(!day)warnings.push('فاتورة '+(number||'بلا رقم')+' بلا تاريخ ورقي مؤكد: '+actual.reason);
   const row:ColonelInvoice={number:number||String(invoice.number||'بدون رقم'),date:day,
    branch:record.branch||draft.branch||'',amount:String(invoice.amount||''),
    recordId:record.id,complete:invoice.complete===true,dateSource:actual.source,
    transfers:ids,status:record.status||''};
   allInvoices.push(row);
   if(number){
    const refs=invoiceGroups.get(number)||new Set<string>();refs.add(record.id);invoiceGroups.set(number,refs);
   }
  }
  groupDays.set(record.id,dates);
  for(const no of ids){
   const existing=fromProject.get(no)||{records:new Set<string>(),invoices:new Set<string>(),groups:new Set<string>()};
   existing.records.add(record.id);existing.groups.add(record.id);
   draft.invoices.forEach(inv=>{
    const number=invoiceDocumentNo(inv.number||'');
    if(number)existing.invoices.add(number);
   });
   fromProject.set(no,existing);
  }
 }
 for(const [number,groups] of invoiceGroups)if(groups.size>1)
  warnings.push('رقم الفاتورة '+number+' مكرر في مجموعات المشروع؛ لا يجوز اختيار أحدها تلقائيًا.');
 const byInvoice=new Map<string,Set<string>>();
 for(const invoice of allInvoices){
  if(!invoice.date||!invoice.number||invoice.number==='بدون رقم')continue;
  const dates=byInvoice.get(invoice.number)||new Set<string>();dates.add(invoice.date);
  byInvoice.set(invoice.number,dates);
 }
 const byDecision=new Map(decisions.map(d=>[d.transfer_no,d]));
 const byAssign=new Map(assignments.map(a=>[a.transfer_no,a]));
 const byNumber=new Map(sap.map(s=>[s.transfer.number,s]));
 const movement=analyzeLieutenantMovements(sap,end);
 const considered=new Set<string>();
 const transfers:ColonelTransfer[]=[];
 for(const source of sap){
  const number=source.transfer.number;
  if(considered.has(number)){warnings.push('ترحيل '+number+' مكرر في كشف SAP المقروء.');continue;}
  considered.add(number);
  const project=fromProject.get(number);
  const linkNumbers=unique([...(project?[...project.invoices]:[]),...(source.invoiceNumbers||[])]);
  const days=new Set<string>();
  for(const inv of linkNumbers)for(const day of byInvoice.get(inv)||[])days.add(day);
  const groupDateSets=project?[...project.groups].map(id=>groupDays.get(id)||new Set<string>()):[];
  for(const dates of groupDateSets)for(const day of dates)days.add(day);
  const manual=byAssign.get(number);
  if(manual?.invoice_day)days.add(manual.invoice_day);
  if(days.size>1)warnings.push('الترحيل '+number+' منسوب إلى أكثر من تاريخ فاتورة؛ يحتاج مراجعة.');
  const day=days.size===1?[...days][0]:'';
  const m=movement.get(number);
  const kind=m?.kind||'normal';
  const matching=settled(kind)||m?.verifiedOffset===true;
  const decision=byDecision.get(number);
  const missingProject=!project;
  const cash=isCashVanTransfer(source);
  const noInvoice=!project||project.invoices.size===0;
  const uncertain=source.issues.length>0||correction(kind)&&!m?.verifiedOffset||
    kind==='cashvan-pending'||(source.cancellationMentioned&&!matching&&kind==='normal');
  const needsAction=source.issues.length>0||days.size>1||uncertain||
    (!matching&&!cash&&!source.reverse&&!source.signedAdjustment&&noInvoice)||
    (!matching&&cash);
  const note=[
   ...(source.issues.length?source.issues:[]),
   m?.note||'',
   missingProject?'غير مسجل ضمن مجموعة فواتير المشروع':'',
   !day?'لم يثبت تاريخ فاتورته الزرقاء؛ لا ينسب ليوم SAP تلقائيًا':'',
   decision?('قرار الملازم: '+(decision.decision==='ignore'?'تجاوز إداري':decision.decision==='keep'?'عدم الإلغاء بسبب فاتورة':'ربط مستند')+
    (decision.related_number?' — '+decision.related_number:'')+(decision.note?' — '+decision.note:'')):'',
  ].filter(Boolean).join(' | ');
  transfers.push({number,postingDate:source.transfer.date,invoiceDay:day,
   invoiceNumbers:linkNumbers,branch:source.branch,state:kind,note,counterparts:
    unique([...(m?.counterparts||[]),...(m?.counterpart?[m.counterpart]:[])]),
   needsAction,source:'sap',recordIds:project?[...project.records]:[],
   inProject:!!project,decision:decision?.decision||''});
 }
 // Historical project transfers missing from the CURRENT SAP extract are not
 // proof of non-posting, or cancellation; they remain explicit audit exceptions.
 for(const [number,project] of fromProject){
  if(considered.has(number))continue;
  const days=new Set<string>();
  for(const id of project.groups)for(const day of groupDays.get(id)||[])days.add(day);
  const assigned=byAssign.get(number);
  if(assigned?.invoice_day)days.add(assigned.invoice_day);
  const day=days.size===1?[...days][0]:'';
  transfers.push({number,postingDate:'',invoiceDay:day,invoiceNumbers:[...project.invoices],
   branch:'',state:'not-in-current-sap-source',note:'مسجل في المشروع وغير موجود في كشف SAP المقروء؛ لا يعني أنه غير مرحّل أو ملغى.',
   counterparts:[],needsAction:true,source:'project',recordIds:[...project.records],inProject:true,decision:''});
 }
 const states=new Map(dayStates.map(s=>[s.day,s]));
 const days:ColonelDay[]=[];
 let cursor=month+'-01';
 while(cursor<=end){
  const invoices=allInvoices.filter(x=>x.date===cursor);
  const linked=transfers.filter(x=>x.invoiceDay===cursor);
  const duplicate=invoices.some(x=>invoiceGroups.get(x.number)?.size!==1);
  const inferred=invoices.some(x=>x.dateSource==='transfer');
  const openCount=linked.filter(x=>x.needsAction).length+
   invoices.filter(x=>!x.complete||!x.number||x.number==='بدون رقم').length+
   (duplicate?1:0);
  const state=states.get(cursor);
  // An inferred date is not a confirmed paper date; closing requires manual
  // validation in the source invoice, never a guessed SAP posting date.
  const ready=sourceReady&&!!state?.invoices_complete&&openCount===0&&!inferred&&
   invoices.length>0;
  const reason=!sourceReady?'كشف SAP غير متاح أو تغطيته غير مثبتة':
   !state?.invoices_complete?'الفواتير الزرقاء لم تُعتمد مكتملة':
   inferred?'يوجد تاريخ فاتورة مستنتج من SAP يحتاج تأكيد الورق':
   !invoices.length?'لا توجد فواتير مثبتة لهذا اليوم':
   openCount?'يوجد '+openCount+' حالة تحتاج إجراء':
   'الفواتير مكتملة والحالات المرتبطة بهذا اليوم لا تحمل ملاحظات مفتوحة في الكشف المقروء';
  days.push({day:cursor,invoices,transfers:linked,invoicesComplete:!!state?.invoices_complete,
   confirmedAt:state?.confirmed_at||'',openCount,undatedCount:0,ready,reason});
  const next=new Date(cursor+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);
  cursor=next.toISOString().slice(0,10);
 }
 const unassigned=transfers.filter(x=>!x.invoiceDay||x.invoiceDay<month+'-01'||x.invoiceDay>end);
 const undated=allInvoices.filter(x=>!x.date);
 const open=days.reduce((sum,d)=>sum+d.openCount,0)+unassigned.filter(x=>x.needsAction).length;
 return {days,unassigned,undated,warnings:unique(warnings),
  stats:{invoices:days.reduce((n,d)=>n+d.invoices.length,0),
   sapTransfers:sap.length,open,unassigned:unassigned.length,ready:days.filter(d=>d.ready).length}};
}
