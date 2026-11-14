import type {LieutenantTransfer} from './lieutenant';
import {analyzeLieutenantMovements} from './lieutenant-counterparts';

export type ImportDocumentResult={number:string;state:'pending'|'added'|'existing'|'excluded';reason:string};

/** One classification per SAP document. Exclusions remain inspectable, including
 * movements outside the selected dates; none become missing blue invoices. */
export function lieutenantImportPlan(source:LieutenantTransfer[],from:string,to:string){
  const movements=analyzeLieutenantMovements(source,to);
  return source.map(row=>{
    const movement=movements.get(row.transfer.number);
    const reason=row.issues.length?row.issues.join(' · '):
      !row.transfer.date?'تاريخ SAP غير صالح':
      row.transfer.date<from||row.transfer.date>to?'خارج فترة الاستيراد المختارة':
      row.signedAdjustment?'تصحيح كمية موقّع؛ يُراجع ضمن حركات المخزون':
      movement?.kind!=='normal'?movement?.note||'ليست حركة وارد عادية إلى 011':'';
    return {number:row.transfer.number,state:reason?'excluded':'pending',reason} as ImportDocumentResult;
  });
}
