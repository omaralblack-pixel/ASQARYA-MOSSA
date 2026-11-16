import {dateValue,digits,invoiceDocumentNo,parseTransfer,withInvoiceDates,type Draft} from './reconcile';
import type {SapImportGroup} from './sap-import';

/** Printed SAP transfer copies sometimes show a blue invoice in the operator
 * notes even though the SAP export's Remarks column still contains a transfer
 * request. Treat the printed number as a proposed *manual* link, never as
 * something inferred from SAP or already financially approved. */
export function draftFromPaperInvoice(
  member:SapImportGroup['members'][number],rawInvoice:string
):Draft{
  const number=invoiceDocumentNo(rawInvoice);
  if(!/^\d{10}$/.test(number)||!/^\d{4,20}$/.test(digits(member.transfer.number)))
    throw Error('أدخل رقم فاتورة زرقاء من 10 خانات ورقم ترحيل SAP صحيحًا.');
  if(member.reversal||member.reverseMovement||member.canceledTransferNo)
    throw Error('هذا الترحيل عكسي أو متعلق بإلغاء. يلزم مراجعته قبل ربط فاتورة زرقاء.');
  if(member.issues.length)
    throw Error('الترحيل فيه ملاحظات قراءة SAP: '+member.issues.join('، '));
  if(!member.branch)throw Error('فرع هذا الترحيل غير مثبت في كشف SAP؛ لا يمكن ربط الفاتورة تلقائيًا.');
  if(member.invoices.length&&(!member.invoices.includes(number)||member.invoices.length>1))
    throw Error('ملاحظات SAP تربط الترحيل بفواتير أخرى ('+member.invoices.join('، ')+'). راجعها قبل تغيير الربط.');
  const parsed=parseTransfer(member.transfer.paste,{allowReverse:true});
  if(!parsed.lines.length||parsed.issues.length||parsed.excluded.length)
    throw Error('أصناف الترحيل ناقصة أو غير صالحة. راجع كشف SAP قبل ربط الفاتورة.');
  const date=dateValue(member.transfer.date);
  if(!date)throw Error('تاريخ الترحيل غير صالح في كشف SAP.');
  const notes=['ربط ورقي مقترح للمراجعة فقط: الفاتورة '+number+' على الترحيل '+member.transfer.number+'.',
    member.invoices.includes(number)?'رقم الفاتورة مثبت في ملاحظات SAP المحفوظة.':'رقم الفاتورة مأخوذ من المستند الورقي ولم يظهر في حقول ملاحظات كشف SAP المحفوظ.',
    'SAP Remarks الأصلي: '+member.remarks].join('\n').slice(0,4500);
  return withInvoiceDates({
    mode:'manual',branch:member.branch,driver:'',date,transfers:[member.transfer],
    invoices:[{id:'paper-'+number,number,date:'',dateTransferNos:[member.transfer.number],
      manualNumber:true,amount:'',complete:false,quantities:{},attachments:[]}],
    checks:{},notes
  });
}
