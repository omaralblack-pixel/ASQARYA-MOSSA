import {dateValue, invoiceDocumentNo, pageNumber, parseTransfer, sapReferences, soldierLineKey, transferNumbers, type Draft} from './reconcile';

export type CollectedInvoice = {
  recordId: string; invoiceId: string; number: string; branch: string; date: string;
  transferNumbers: string[]; unresolvedTransferNumbers: string[]; groupConfirmedTransfers: string[]; amount: string;
};
export type CollectedInvoiceResult = {
  from: string; to: string; days: number; rows: CollectedInvoice[];
  unreadableRecords: number; undatedInvoices: number;
};

const close=(a:number,b:number)=>Math.abs(a-b)<0.000001;

/** Read-only invoice registry. The collector does not calculate prices, audit quantities, or modify records.
 * Transfer links in multi-invoice records must be proved by saved row/page allocation.
 * Unknown links are reported separately rather than assigned to every invoice.
 */
export function collectInvoicesByDate(
  records:{id:string;branch:string;status?:string;payload:string}[],fromInput:string,toInput:string,
):CollectedInvoiceResult{
  const from=dateValue(fromInput),to=dateValue(toInput);
  if(!from||!to)throw Error('اختر تاريخ بداية ونهاية صحيحين.');
  if(from>to)throw Error('تاريخ البداية يجب ألا يأتي بعد تاريخ النهاية.');
  const days=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
  if(days>366)throw Error('أقصى مدة للجمع 366 يومًا.');

  const rows:CollectedInvoice[]=[];
  let unreadableRecords=0,undatedInvoices=0;
  for(const record of records){
    let draft:Draft;
    try{
      draft=JSON.parse(record.payload) as Draft;
      if(!draft||typeof draft!=='object'||!Array.isArray(draft.invoices)||!Array.isArray(draft.transfers))throw Error('invalid');
      if(draft.invoices.some(inv=>!inv||typeof inv!=='object'))throw Error('invalid invoice');
    }catch{unreadableRecords++;continue}

    const invoices=draft.invoices;
    const multi=invoices.length>1;
    const savedStatus=(draft as Draft&{summary?:{status?:string}}).summary?.status||record.status;
    const approvedHistoricalGroup=multi&&savedStatus==='match'&&
      invoices.every(invoice=>{const dt=dateValue(invoice.date||'');return !!dt&&dt<'2026-11-11';});
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
      const date=dateValue(invoice.date||'');
      if(!date){undatedInvoices++;continue}
      if(date<from||date>to)continue;
      rows.push({
        recordId:record.id,invoiceId:invoice.id,
        number:invoiceDocumentNo(invoice.number)||String(invoice.number||''),
        branch:record.branch||draft.branch||'',
        date,transferNumbers:[...(exactByPage.get(index+1)||new Set<string>())],
        unresolvedTransferNumbers:[...new Set([...uncertain,...(approvedHistoricalGroup?[]:[...pageUnallocated])])],
        groupConfirmedTransfers:approvedHistoricalGroup?[...pageUnallocated]:[],
        amount:String(invoice.amount||''),
      });
    }
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.number.localeCompare(b.number,'en',{numeric:true}));
  return {from,to,days,rows,unreadableRecords,undatedInvoices};
}
