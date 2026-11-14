import type {LieutenantTransfer} from './lieutenant';
import {analyzeLieutenantMovements,lieutenantDirections} from './lieutenant-counterparts';

export type CancellationDecisionKind='ignore'|'linked'|'keep';
export type CancellationRelatedType=''|'transfer'|'invoice'|'other';
export type CancellationDecision={
  transfer_no:string;decision:CancellationDecisionKind;related_type:CancellationRelatedType;
  related_number:string;note:string;revision:number;updated_at:string;
};
export type CancellationDecisionInput={
  transferNo:string;decision:CancellationDecisionKind;
  relatedType:CancellationRelatedType;relatedNumber:string;note:string;
};
export type CancellationReviewRow={
  source:LieutenantTransfer;kind:string;automaticReason:string;
  counterparts:string[];directions:string[];proven:boolean;
};
/** A manual decision documents the operator's review. It NEVER changes
 * SAP cancellation flags, physical inventory math, or approved invoices. */
export function validateCancellationDecision(input:unknown):
  {value?:CancellationDecisionInput;error?:string}{
  if(!input||typeof input!=='object'||Array.isArray(input))
    return {error:'بيانات قرار الإلغاء غير صالحة.'};
  const row=input as Record<string,unknown>;
  if([row.transferNo,row.decision,row.relatedType,row.relatedNumber,row.note]
    .some(value=>typeof value!=='string'))
    return {error:'أكمل حقول قرار الإلغاء بالنص الصحيح.'};
  const transferNo=(row.transferNo as string).trim();
  const decision=row.decision as string;
  const relatedType=row.relatedType as string;
  const relatedNumber=(row.relatedNumber as string).trim();
  const note=(row.note as string).trim();
  if(!/^\d{4,20}$/.test(transferNo))return {error:'رقم الترحيل غير صالح.'};
  if(!['ignore','linked','keep'].includes(decision))
    return {error:'اختر تجاوزًا أو ربط مستند أو عدم الإلغاء بسبب فاتورة.'};
  if(note.length>600||/\p{Cc}/u.test(note))
    return {error:'الملاحظة طويلة أو تتضمن رموز تحكم غير مسموحة (الحد 600 حرف).'};
  if(decision==='ignore'){
    if(relatedType||relatedNumber)return {error:'قرار التجاوز لا يحتاج مستندًا مقابلًا.'};
    return {value:{transferNo,decision:'ignore',relatedType:'',relatedNumber:'',note}};
  }
  if(decision==='keep'){
    if(relatedType!=='invoice'||!/^\d{10}$/.test(relatedNumber))
      return {error:'سجّل رقم الفاتورة الزرقاء الصحيح (10 أرقام) قبل اعتماد عدم الإلغاء.'};
    return {value:{transferNo,decision:'keep',relatedType:'invoice',relatedNumber,note}};
  }
  if(!['invoice','transfer','other'].includes(relatedType)||!relatedNumber||
    relatedNumber.length>100||/\p{Cc}/u.test(relatedNumber))
    return {error:'اختر نوع المستند المرتبط وأدخل رقمه أو وصفه.'};
  if(relatedType==='invoice'&&!/^\d{10}$/.test(relatedNumber))
    return {error:'رقم الفاتورة الزرقاء يجب أن يكون 10 أرقام.'};
  if(relatedType==='transfer'&&(!/^\d{4,20}$/.test(relatedNumber)||relatedNumber===transferNo))
    return {error:'أدخل رقم ترحيل آخر صحيح غير رقم الترحيل الجاري.'};
  return {value:{transferNo,decision:'linked',relatedType:relatedType as CancellationRelatedType,
    relatedNumber,note}};
}

export function cancellationReviewRows(
  transfers:LieutenantTransfer[],from:string,to:string,
):CancellationReviewRow[]{
  const analyzed=analyzeLieutenantMovements(transfers,to);
  const byNumber=new Map(transfers.map(row=>[row.transfer.number,row]));
  return transfers.filter(source=>{
    const date=source.transfer.date;
    if(!date||date<from||date>to)return false;
    const kind=analyzed.get(source.transfer.number)?.kind;
    return source.cancellationState==='canceled'||source.cancellationState==='cancellation'||
      kind==='cancellation-review'||source.cancellationMentioned;
  }).map(source=>{
    const movement=analyzed.get(source.transfer.number);
    const counterparts=[...new Set([
      ...(movement?.counterparts||[]),
      ...(movement?.counterpart?[movement.counterpart]:[]),
    ])];
    const proven=!!counterparts.length&&(
      movement?.kind==='sap-cancel-doc'||
      movement?.kind==='sap-canceled'&&counterparts.some(no=>byNumber.has(no)));
    const kind=source.cancellationState==='canceled'?'ملغى رسميًا في SAP (Y)':
      source.cancellationState==='cancellation'?'مستند إلغاء SAP (C)':
      source.signedAdjustment?'تصحيح كمية مع ملاحظة إلغاء':
      'Remarks تشير إلى إلغاء يحتاج إثباتًا';
    const automaticReason=proven?'مستند مقابل مثبت في الكشف: '+counterparts.join('، '):
      'سبب الإلغاء أو المستند المقابل غير مثبت في هذا الكشف.';
    return {source,kind,automaticReason,counterparts,
      directions:lieutenantDirections(source),proven};
  }).sort((a,b)=>a.source.transfer.date.localeCompare(b.source.transfer.date)||
    a.source.transfer.number.localeCompare(b.source.transfer.number,'en',{numeric:true}));
}
