import {invoiceDocumentNo,parseTransfer,readReconciliationRecord,transferNumbers,type Draft} from './reconcile';
import type {LieutenantTransfer} from './lieutenant';

export type LieutenantSavedRecord={id:string;status:string;payload:string};
const signature=(pastes:string[])=>{
  const totals=new Map<string,number>();
  for(const paste of pastes){
    const parsed=parseTransfer(paste,{allowReverse:true});
    if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length)return null;
    for(const line of parsed.lines){
      const key=[line.sapCode,line.unit,line.from,line.to].join('|');
      totals.set(key,(totals.get(key)||0)+line.quantity);
    }
  }
  return JSON.stringify([...totals].map(([key,quantity])=>[key,Number(quantity.toFixed(6))])
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
};

/** A saved match covers only the SAP quantities that were actually reviewed.
 * Reusing a document number after its source changes cannot approve new stock.
 * Combined legacy cards are verified against all their documents together.
 */
export function lieutenantApprovals(sources:LieutenantTransfer[],records:LieutenantSavedRecord[]){
  const byNumber=new Map(sources.map(source=>[source.transfer.number,source]));
  const approved=new Set<string>(),warnings=new Map<string,string>();
  for(const record of records){
    if(record.status!=='match')continue;
    const draft=readReconciliationRecord(record.payload);
    if(!draft||!draft.invoices.length||!draft.invoices.every(row=>invoiceDocumentNo(row.number)&&row.complete))continue;
    for(const card of draft.transfers){
      const numbers=transferNumbers(card.number||'');
      const actual=numbers.map(number=>byNumber.get(number));
      const saved=typeof card.paste==='string'?signature([card.paste]):null;
      const current=actual.every(row=>row&&!row.issues.length)?
        signature(actual.map(row=>row!.transfer.paste)):null;
      const verified=!!numbers.length&&!!saved&&saved===current;
      for(const number of numbers){
        if(!byNumber.has(number))continue;
        if(verified&&!warnings.has(number))approved.add(number);
        else{
          approved.delete(number);
          warnings.set(number,'المجموعة معتمدة، لكن بنود/كميات ملف SAP الحالي لا تطابق نسخة الترحيل التي شُيّكت، أو ينقص جزء من الترحيل المجمّع. افتح الفاتورة للمراجعة.');
        }
      }
    }
  }
  return {approved,warnings};
}
