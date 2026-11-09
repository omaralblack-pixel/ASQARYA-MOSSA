import {dateValue,fils,money,parseTransfer,transferNumbers,type Draft} from './reconcile';

type HistoryRecord={id:string;branch:string;doc_date:string;payload:string};
export const historyHeaders=['رقم الفاتورة الزرقاء','اسم الفاتورة / الفرع','تاريخ الفاتورة الزرقاء','ترحيلات المجموعة للمؤسسة','الترحيلات العكسية للمجموعة','ترحيلات بحاجة تحديد الاتجاه','حالة الفاتورة','مبلغ الفاتورة (د.أ)'];

export function historyExportRows(records:HistoryRecord[]):string[][]{
 const rows:{date:string;values:string[]}[]=[];
 for(const record of records){
  const group=JSON.parse(record.payload) as Draft;
  const forward:string[]=[],reverse:string[]=[],unknown:string[]=[];
  for(const transfer of group.transfers||[]){
   const numbers=transferNumbers(transfer.number||'');
   if(!numbers.length)continue;
   const parsed=parseTransfer(transfer.paste||'',{allowReverse:true});
   const hasForward=parsed.lines.some(line=>line.to==='011');
   const hasReverse=parsed.lines.some(line=>line.from==='011');
   const target=parsed.issues.length||parsed.excluded.length||!parsed.lines.length||hasForward===hasReverse?unknown:hasReverse?reverse:forward;
   target.push(...numbers);
  }
  for(const invoice of group.invoices||[]){
   const amount=fils(invoice.amount||'');
   rows.push({date:dateValue(invoice.date||'')||dateValue(record.doc_date||'')||'',values:[invoice.number||'',record.branch||'',dateValue(invoice.date||'')||'', [...new Set(forward)].join(' + '),[...new Set(reverse)].join(' + '),[...new Set(unknown)].join(' + '),invoice.complete?'واصلاني':'غير مكتملة',amount===null?'':money(amount)]});
  }
 }
 return [historyHeaders,...rows.sort((a,b)=>(a.date||'9999-99-99').localeCompare(b.date||'9999-99-99')).map(row=>row.values)];
}
