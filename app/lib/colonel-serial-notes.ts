import type {LieutenantTransfer} from './lieutenant';
import type {CancellationDecision} from './lieutenant-cancellation-decisions';
import {analyzeLieutenantMovements,isCashVanTransfer} from './lieutenant-counterparts';

/** One annotation per actual SAP transfer; administrative decisions are never
 * silently promoted to SAP cancellation evidence. Used by both Excel exports. */
export function colonelSerialNotes(
 sap:LieutenantTransfer[],decisions:CancellationDecision[],asOf:string,
):Map<string,string>{
 const result=new Map<string,string>();
 const movements=analyzeLieutenantMovements(sap,asOf);
 const decisionsByNumber=new Map(decisions.map(row=>[row.transfer_no,row]));
 for(const transfer of sap){
  const number=transfer.transfer.number;
  const move=movements.get(number);
  const counterpart=[...(move?.counterparts||[]),...(move?.counterpart?[move.counterpart]:[])];
  const kind=move?.kind||'normal';
  const notes:string[]=[];
  if(transfer.cancellationState==='canceled'||kind==='sap-canceled')
   notes.push('ملغى رسميًا على SAP'+(counterpart.length?'؛ مستند المقابل '+[...new Set(counterpart)].join('، '):''));
  else if(transfer.cancellationState==='cancellation'||kind==='sap-cancel-doc')
   notes.push('مستند إلغاء SAP'+(counterpart.length?' لأصل '+counterpart.join('، '):''));
  else if(kind==='reversed')
   notes.push('مُسوّى بترحيل عكسي مطابق رقم '+counterpart.join('، ')+'؛ ليس إلغاء SAP');
  else if(kind==='reverse')
   notes.push('حركة عكسية مقابلة رقم '+counterpart.join('، ')+'؛ لا تحتاج فاتورة زرقاء مستقلة');
  else if(move?.verifiedOffset===true)
   notes.push('تصحيح كمية سالب مطابق رقم '+counterpart.join('، ')+'؛ حالة إلغاء SAP غير مثبتة');
  else if(kind==='cashvan-pending'||isCashVanTransfer(transfer))
   notes.push('كاش فان: بانتظار عكسي مطابق أو إلغاء مثبت على SAP'+
    (counterpart.length?'؛ مراجع '+counterpart.join('، '):''));
  else if(kind==='cancellation-review'||transfer.cancellationMentioned)
   notes.push('ذكر إلغاء/تصحيح يحتاج إثبات SAP'+
    (counterpart.length?'؛ مرجع '+counterpart.join('، '):''));
  if(transfer.issues.length)
   notes.push('مشاكل قراءة SAP: '+transfer.issues.slice(0,4).join('، '));
  const decision=decisionsByNumber.get(number);
  if(decision){
   const description=decision.decision==='ignore'?'تجاوز إداري فقط، لا يثبت إلغاء SAP':
    decision.decision==='keep'?'قرار عدم إلغاء بسبب الفاتورة':
     'ربط إداري بمستند؛ لا يثبت الإلغاء وحده';
   notes.push(description+(decision.related_number?' '+decision.related_number:'')+
    (decision.note?' — '+decision.note:''));
  }
  if(notes.length)result.set(number,'الترحيل '+number+': '+notes.join(' | '));
 }
 // A saved lieutenant decision without an SAP source stays explicitly
 // administrative; the exporter must not fabricate a cancellation.
 for(const decision of decisions){
  if(result.has(decision.transfer_no))continue;
  result.set(decision.transfer_no,'الترحيل '+decision.transfer_no+
   ': قرار الملازم محفوظ ('+(decision.decision==='ignore'?'تجاوز إداري':
    decision.decision==='keep'?'لا يُلغى بحسب قرار إداري':'ربط مستند')+
   (decision.related_number?' — '+decision.related_number:'')+
   ')؛ حالة SAP غير مثبتة في الكشف المقروء');
 }
 return result;
}
