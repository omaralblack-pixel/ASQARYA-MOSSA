import {dateValue, invoiceDocumentNo, pageNumber, parseTransfer, readReconciliationRecord, sapReferences, soldierLineKey, transferNumbers, type Draft} from './reconcile';

export type CollectedInvoice = {
  recordId: string; invoiceId: string; number: string; branch: string; date: string; dateSource: 'manual'|'invoice'|'transfer';
  transferNumbers: string[]; unresolvedTransferNumbers: string[]; groupConfirmedTransfers: string[]; amount: string;
};
export type UndatedInvoice = {
  recordId:string; invoiceId:string; number:string; branch:string; amount:string;
  originalDate:string; recordDate:string; transferNumbers:string[]; reason:string;
};
export type CollectedInvoiceResult = {
  from: string; to: string; days: number; rows: CollectedInvoice[];
  unreadableRecords: number; undatedInvoices: number;
  undatedDetails:UndatedInvoice[]; inferredDates:number;
};

const close=(a:number,b:number)=>Math.abs(a-b)<0.000001;

/** Invoice-free transfer cards remain visible without inflating invoice counts. */
export function collectedInvoiceCounts(report:Pick<CollectedInvoiceResult,'rows'>){
 const numbered=report.rows.filter(row=>!!invoiceDocumentNo(row.number));
 return {invoices:numbered.length,withoutNumber:report.rows.length-numbered.length,
  inferredDates:numbered.filter(row=>row.dateSource==='transfer').length};
}

/** Date on a saved invoice takes precedence. If missing or invalid, derive the
 * original system default (outgoing SAP posting date minus one day) ONLY when
 * one unambiguous posting date can be established. Historical records never change.
 */
function invoiceDate(
  invoice:Draft['invoices'][number],transfers:Draft['transfers'],
):{date:string|null;source:'manual'|'invoice'|'transfer';reason:string}{
  const saved=dateValue(invoice.date||'');
  // An explicitly saved manual date is authoritative, even if the posting
  // date implies another day. A missing/invalid manual date must NEVER fall
  // back to SAP or the document date.
  if(invoice.manualDate===true){
    return saved?{date:saved,source:'manual',reason:''}:
      {date:null,source:'manual',reason:'التاريخ اليدوي مفقود أو غير صالح؛ يلزم تصحيحه يدويًا.'};
  }
  // Old records might predate the manualDate flag. Their stored date is still
  // authoritative; SAP is consulted ONLY when this field is unusable.
  if(saved)return {date:saved,source:'invoice',reason:''};
  let incompleteSource=false;
  const outgoing=transfers.flatMap(transfer=>{
    if(!transfer||typeof transfer.paste!=='string'){incompleteSource=true;return []}
    const parsed=parseTransfer(transfer.paste,{allowReverse:true});
    if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length){
      incompleteSource=true;return [];
    }
    // Ignore valid reverse-only transfers; they do not determine invoice date.
    if(!parsed.lines.some(line=>line.to==='011'&&['001','002','009'].includes(line.from)))return [];
    const numbers=transferNumbers(transfer.number||'');
    if(numbers.length!==1||!/^\d{4,20}$/.test(numbers[0])){
      incompleteSource=true;return [];
    }
    return [{numbers,date:dateValue(transfer.date||'')}];
  });
  if(incompleteSource)return {date:null,source:'invoice',
    reason:'هناك ترحيل SAP غير مكتمل؛ لا يمكن اشتقاق تاريخ الفاتورة بأمان.'};
  const linked=Array.isArray(invoice.dateTransferNos)&&invoice.dateTransferNos.length>0;
  const wanted=new Set(linked?invoice.dateTransferNos!.flatMap(n=>transferNumbers(String(n))):[]);
  const sources=linked?outgoing.filter(row=>row.numbers.some(n=>wanted.has(n))):outgoing;
  const found=new Set(sources.flatMap(row=>row.numbers));
  if(linked&&[...wanted].some(number=>!found.has(number)))
    return {date:null,source:'invoice',reason:'بعض الترحيلات المحددة لتاريخ الفاتورة غير موجودة أو غير صالحة.'};
  if(!sources.length)
    return {date:null,source:'invoice',reason:linked?'الترحيل المحدد لتاريخ الفاتورة غير موجود أو ليس حركة توريد صالحة.':'لا يوجد ترحيل توريد يمكن استخراج التاريخ منه.'};
  const unique=new Set(sources.map(row=>row.date));
  if(unique.has(null)||unique.size!==1)
    return {date:null,source:'invoice',reason:'ترحيلات الفاتورة لها تواريخ مختلفة أو ناقصة؛ لا يمكن اختيار تاريخ دون تأكيد.'};
  const posting=sources[0].date!;
  const day=new Date(posting+'T00:00:00Z');
  day.setUTCDate(day.getUTCDate()-1);
  return {date:day.toISOString().slice(0,10),source:'transfer',reason:''};
}

/** Read-only invoice registry. The collector does not calculate prices, audit quantities, or modify records.
 * Transfer links in multi-invoice records must be proved by saved row/page allocation.
 * Unknown links are reported separately rather than assigned to every invoice.
 */
export function collectInvoicesByDate(
  records:{id:string;branch:string;status?:string;doc_date?:string;payload:string}[],fromInput:string,toInput:string,
):CollectedInvoiceResult{
  const from=dateValue(fromInput),to=dateValue(toInput);
  if(!from||!to)throw Error('اختر تاريخ بداية ونهاية صحيحين.');
  if(from>to)throw Error('تاريخ البداية يجب ألا يأتي بعد تاريخ النهاية.');
  const days=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
  if(days>366)throw Error('أقصى مدة للجمع 366 يومًا.');

  const rows:CollectedInvoice[]=[],undatedDetails:UndatedInvoice[]=[];
  let unreadableRecords=0,undatedInvoices=0,inferredDates=0;
  for(const record of records){
    const draft=readReconciliationRecord(record.payload);
    if(!draft){unreadableRecords++;continue}

    const invoices=draft.invoices;
    const multi=invoices.length>1;
    const dates=invoices.map(invoice=>invoiceDate(invoice,draft.transfers));
    const savedStatus=(draft as Draft&{summary?:{status?:string}}).summary?.status||record.status;
    const approvedHistoricalGroup=multi&&savedStatus==='match'&&
      dates.every(({date})=>!!date&&date<'2026-11-11');
    const exactByPage=new Map<number,Set<string>>();
    const uncertain=new Set<string>();
    const pageUnallocated=new Set<string>();
    const reference=new Map(sapReferences(draft.referenceSnapshot||[]).map(item=>[item.sapCode.toUpperCase(),item.code]));
    for(const transfer of draft.transfers){
      if(!transfer||typeof transfer!=='object'){unreadableRecords++;continue}
      const numbers=transferNumbers(transfer.number||'');
      if(!numbers.length)continue;
      if(!multi){
        if(!exactByPage.has(1))exactByPage.set(1,new Set());
        numbers.forEach(number=>exactByPage.get(1)!.add(number));
        continue;
      }
      const parsed=parseTransfer(transfer.paste||'',{allowReverse:true});
      if(!parsed.lines.length||parsed.issues.length||parsed.excluded.length){
        numbers.forEach(number=>uncertain.add(number));continue;
      }
      const pages=new Set<number>();
      let reliable=true;
      for(const line of parsed.lines){
        const key=soldierLineKey(transfer.id,line);
        const parts=draft.soldierLineAllocations?.[key];
        if(draft.soldierLineAllocations!==undefined){
          const total=draft.soldierLineTotals?.[key];
          if(!parts||typeof total!=='number'||!Number.isFinite(total)||total<=0||
            !Object.keys(parts).length||
            Object.entries(parts).some(([page,qty])=>
              !/^\d+$/.test(page)||Number(page)<1||Number(page)>invoices.length||
              typeof qty!=='number'||!Number.isFinite(qty)||qty<=0)||
            !close(Object.values(parts).reduce((n,qty)=>n+qty,0),total)){
            reliable=false;break;
          }
          Object.keys(parts).forEach(page=>pages.add(Number(page)));
        }else{
          const itemCode=reference.get(line.sapCode.toUpperCase());
          const institutionPage=itemCode?pageNumber(draft.pages?.['i:'+itemCode]):0;
          const sapPage=pageNumber(draft.pages?.['s:'+line.sapCode.toUpperCase()]);
          if(institutionPage&&sapPage&&institutionPage!==sapPage){reliable=false;break}
          const page=institutionPage||sapPage;
          if(!page||page>invoices.length){reliable=false;break}
          pages.add(page);
        }
      }
      if(!reliable||!pages.size){numbers.forEach(number=>pageUnallocated.add(number));continue}
      for(const page of pages){
        if(!exactByPage.has(page))exactByPage.set(page,new Set());
        numbers.forEach(number=>exactByPage.get(page)!.add(number));
      }
    }

    for(const [index,invoice] of invoices.entries()){
      const {date,source,reason}=dates[index];
      if(!date){
        undatedInvoices++;
        if(undatedDetails.length<200)undatedDetails.push({
          recordId:record.id,invoiceId:invoice.id,
          number:invoiceDocumentNo(invoice.number)||String(invoice.number||''),
          branch:record.branch||draft.branch||'',amount:String(invoice.amount||''),
          originalDate:String(invoice.date||''),recordDate:String(record.doc_date||draft.date||''),
          transferNumbers:[...new Set(draft.transfers.flatMap(transfer=>transferNumbers(transfer?.number||'')))],
          reason,
        });
        continue;
      }
      if(date<from||date>to)continue;
      if(source==='transfer')inferredDates++;
      rows.push({
        recordId:record.id,invoiceId:invoice.id,
        number:invoiceDocumentNo(invoice.number)||String(invoice.number||''),
        branch:record.branch||draft.branch||'',
        date,dateSource:source,transferNumbers:[...(exactByPage.get(index+1)||new Set<string>())],
        unresolvedTransferNumbers:[...new Set([...uncertain,...(approvedHistoricalGroup?[]:[...pageUnallocated])])],
        groupConfirmedTransfers:approvedHistoricalGroup?[...pageUnallocated]:[],
        amount:String(invoice.amount||''),
      });
    }
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.number.localeCompare(b.number,'en',{numeric:true}));
  return {from,to,days,rows,unreadableRecords,undatedInvoices,undatedDetails,inferredDates};
}
