import {dateValue, digits, invoiceDocumentNo, signedNumeric, readReconciliationRecord, transferNumbers, type Draft} from './reconcile';
import {readSapImportRows} from './sap-import';

// A read-only view of the SAME Supabase-hosted SAP import used by the import screen.
// One SAP transfer can have many item rows; count each invoice only once.
export type SapRegisterInvoice={
  number:string;
  transfers:string[];
  dates:string[];
  branches:string[];
};
export type SapRegisterSource={
  invoices:SapRegisterInvoice[];
  issues:string[];
  transferCount:number;
  sourceRows:number;
  ignoredCount:number;
  withoutInvoice:string[];
};
export type SavedInvoiceRecord={id:string;branch:string;doc_date:string;payload:string};
export type SapRegisterCheck=SapRegisterInvoice&{
  state:'received'|'pending'|'missing'|'review';
  record?:SavedInvoiceRecord;
  reason:string;
  savedAmount:string;
};
const normWarehouse=(value:string)=>digits(value).trim().padStart(3,'0');
function invoiceNumbersFromRemarks(remarks:string):string[]{
  const first=digits(remarks).split(/based on inventory transfer request/i)[0].split('||')[0].trim();
  // Match the same numeric-prefix invoice format the SAP import accepts.
  if(!/^\d+(?:[\s,،;؛/+&-]+\d+)*$/.test(first))return [];
  return [...new Set((first.match(/\d+/g)||[]).filter(v=>/^\d{10}$/.test(v)&&!!invoiceDocumentNo(v)))];
}
export function sapInvoicesFromSavedFile(text:string):SapRegisterSource{
  const source=readSapImportRows(text);
  const docs=new Map<string,string[][]>();
  for(const row of source.rows){
    const doc=digits(row[0]||'').trim();
    if(!docs.has(doc))docs.set(doc,[]);
    docs.get(doc)!.push(row);
  }
  const invoices=new Map<string,{transfers:Set<string>;dates:Set<string>;branches:Set<string>}>();
  const issues=[...source.issues];
  const withoutInvoice:string[]=[];
  let ignoredCount=0,transferCount=0;
  for(const [number,lines] of docs){
    const directed=lines.filter(line=>['001','002','009'].includes(normWarehouse(line[9]||''))&&normWarehouse(line[10]||'')==='011');
    if(!directed.length){ignoredCount++;continue;}
    if(lines.some(line=>/has been cancel(?:ed|led)/i.test(line[4]||'')||(signedNumeric(line[7])??0)<0)){
      ignoredCount++;
      issues.push('الترحيل '+number+': ملغى أو يحتوي كمية سالبة؛ استُبعد من فواتير الوصول.');
      continue;
    }
    if(directed.some(line=>signedNumeric(line[7])===null)){
      issues.push('الترحيل '+number+': كمية غير صالحة؛ لم يُنسب لفاتورة.');
      withoutInvoice.push(number);continue;
    }
    const distinctRemarks=[...new Set(lines.map(line=>(line[4]||'').trim()).filter(Boolean))];
    if(distinctRemarks.length!==1){
      issues.push('الترحيل '+number+': Remarks غير موحدة بين سطوره؛ لم يُنسب لفاتورة.');
      withoutInvoice.push(number);
      continue;
    }
    const numbers=invoiceNumbersFromRemarks(distinctRemarks[0]);
    if(!numbers.length){
      withoutInvoice.push(number);
      continue;
    }
    transferCount++;
    const dates=[...new Set(directed.map(line=>dateValue((line[1]||'').replace(/\./g,'/'))||'').filter(Boolean))];
    const branches=[...new Set(directed.map(line=>(line[3]||line[2]||'').trim()).filter(Boolean))];
    if(dates.length>1||branches.length>1)issues.push('الترحيل '+number+': اختلاف تاريخ أو فرع بين السطور؛ راجع SAP.');
    for(const invoiceNo of numbers){
      const item=invoices.get(invoiceNo)||{transfers:new Set<string>(),dates:new Set<string>(),branches:new Set<string>()};
      item.transfers.add(number);dates.forEach(d=>item.dates.add(d));branches.forEach(b=>item.branches.add(b));
      invoices.set(invoiceNo,item);
    }
  }
  const list=[...invoices.entries()].map(([number,v])=>({
    number,transfers:[...v.transfers].sort((a,b)=>a.localeCompare(b,'en',{numeric:true})),
    dates:[...v.dates].sort(),branches:[...v.branches],
  })).sort((a,b)=>(b.dates[0]||'').localeCompare(a.dates[0]||'')||a.number.localeCompare(b.number));
  if(!list.length)issues.push('لم تُقرأ أي فاتورة من Remarks لترحيلات 001/002/009 إلى 011؛ لا تعتبر الكشف مكتملاً.');
  return {invoices:list,issues,transferCount,sourceRows:source.rows.length,ignoredCount,withoutInvoice};
}
export function compareSapWithSavedInvoices(source:SapRegisterSource,records:SavedInvoiceRecord[]):SapRegisterCheck[]{
  const saved=new Map<string,{record:SavedInvoiceRecord;complete:boolean;amount:string;transfers:string[]}[]>();
  for(const record of records){
    const draft=readReconciliationRecord(record.payload);
    if(!draft)continue;
    const transfers=Array.isArray(draft.transfers)
      ?draft.transfers.flatMap(t=>transferNumbers(t.number||'')):[];
    for(const invoice of draft.invoices){
      const number=invoiceDocumentNo(invoice.number);
      if(!number)continue;
      saved.set(number,[...(saved.get(number)||[]),{
        record,complete:invoice.complete===true,amount:String(invoice.amount||''),transfers,
      }]);
    }
  }
  return source.invoices.map(invoice=>{
    const matches=saved.get(invoice.number)||[];
    const entry=matches[0];
    if(matches.length>1)return {...invoice,state:'review' as const,reason:'رقم الفاتورة مكرر في أكثر من سجل؛ يلزم التحقق من المجموعة الصحيحة.',savedAmount:entry?.amount||'',record:entry?.record};
    if(!entry)return {...invoice,state:'missing' as const,reason:'الفاتورة موجودة في SAP لكن غير مسجلة في سجل المجموعات؛ وصول الورق غير مؤكد.',savedAmount:''};
    const shared=invoice.transfers.some(no=>entry.transfers.includes(no));
    if(!shared)return {...invoice,state:'review' as const,record:entry.record,savedAmount:entry.amount,reason:'رقم الفاتورة مسجل، لكن أرقام الترحيلات في SAP لا تتطابق مع ترحيلات المجموعة.'};
    return {...invoice,state:entry.complete?'received' as const:'pending' as const,
      record:entry.record,savedAmount:entry.amount,reason:entry.complete?'الفاتورة مؤكدة الوصول في سجلك.':'الفاتورة مسجلة لكن علامة وجود الورق غير مفعّلة.'};
  });
}
