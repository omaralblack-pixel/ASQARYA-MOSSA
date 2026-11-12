import {convert,numeric,parseTransfer,sapReferences,soldierLineKey,transferNumbers,
  type Draft,type Item,type TransferLine} from './reconcile';
import type {CollectedInvoice} from './invoice-collector';
import type {LieutenantTransfer} from './lieutenant';
import {analyzeLieutenantMovements} from './lieutenant-counterparts';

export type DayInvoiceState='match'|'late'|'pending'|'short'|'extra'|'review';
export type DayInvoiceRecord={id:string;branch:string;status:string;payload:string};
export type DayInvoiceData={
  rows:CollectedInvoice[];records:DayInvoiceRecord[];
  unreadableRecords:number;undatedInvoices:number;inferredDates:number;
};
export type DayItemResult={code:string;name:string;expected:number;posted:number;difference:number};
export type DayInvoiceResult={
  recordId:string;number:string;branch:string;invoiceDate:string;asOf:string;
  transferNumbers:string[];postedDates:string[];state:DayInvoiceState;
  items:DayItemResult[];notes:string[];
};
export type DayInvoiceReport={rows:DayInvoiceResult[];sourceLastDate:string;};
const epsilon=0.000001;
const near=(a:number,b:number)=>Math.abs(a-b)<epsilon;
const round=(n:number)=>Number(n.toFixed(6));
const signature=(lines:TransferLine[])=>lines.map(line=>[
  line.sapCode,line.quantity.toFixed(6),line.unit,line.from,line.to].join('|')).sort().join('||');
const sourceLines=(row:LieutenantTransfer)=>parseTransfer(row.transfer.paste,{allowReverse:true});
const paperQuantities=(invoice:Draft['invoices'][number])=>{
  const totals=new Map<string,number>(),issues:string[]=[];
  const source=invoice.auditLines?.trim()?
    invoice.auditLines:
    Object.entries(invoice.quantities||{}).map(([code,quantity])=>code+'\t'+quantity).join('\n');
  if(!source.trim())return {totals,issues:['أصناف وكميات الفاتورة الورقية غير مسجلة؛ لا تكفي القيمة الإجمالية للمطابقة.']};
  for(const line of source.replace(/\r/g,'').split('\n')){
    if(!line.trim())continue;
    const fields=line.split('\t').map(field=>field.trim());
    const code=fields[0]?.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))||'';
    if(!/^\d{8}$/.test(code)){issues.push('يوجد سطر في الفاتورة بلا رقم صنف مؤسسة صالح.');continue;}
    const quantity=numeric(fields[1]||'');
    if(quantity===null||quantity<0){issues.push('كمية غير صالحة لصنف المؤسسة '+code);continue;}
    totals.set(code,(totals.get(code)||0)+quantity);
  }
  if(!totals.size)issues.push('لم تُقرأ أي كمية صالحة من الفاتورة الزرقاء.');
  return {totals,issues};
};
const refFor=(reference:Item[],sapCode:string,invoice:Draft['invoices'][number])=>{
  const candidates=sapReferences(reference).filter(item=>item.active&&item.sapCode.toUpperCase()===sapCode);
  const chosen=invoice.sapInstitutionChoices?.[sapCode];
  const selected=chosen?candidates.filter(item=>item.code===chosen):candidates;
  const unique=[...new Set(selected.map(item=>item.code))];
  return unique.length===1?selected[0]:null;
};
const pageParts=(draft:Draft,transferId:string,line:TransferLine,qtyPieces:number,code:string)=>{
  const key=soldierLineKey(transferId,line),explicit=draft.soldierLineAllocations?.[key];
  if(explicit!==undefined){
    const entries=Object.entries(explicit);
    if(!entries.length||entries.some(([page,quantity])=>!/^\d+$/.test(page)||
      Number(page)<1||Number(page)>draft.invoices.length||!Number.isFinite(quantity)||quantity<=0)||
      !near(entries.reduce((total,[,quantity])=>total+quantity,0),Math.abs(qtyPieces)))return null;
    return explicit;
  }
  if(draft.soldierLineAllocations!==undefined)return null;
  const page=Number(draft.pages?.['i:'+code]||draft.pages?.['s:'+line.sapCode]||0);
  return Number.isSafeInteger(page)&&page>=1&&page<=draft.invoices.length?
    {[String(page)]:Math.abs(qtyPieces)}:null;
};

/** Read-only: a blue-invoice date selects invoices; an SAP posting date controls
 * inventory receipt. Never spread one multi-page SAP row across every invoice.
 * Unprovable links, missing unit conversion, or changed SAP contents stay review.
 */
export function auditInvoicesForDay(
  daily:DayInvoiceData,source:LieutenantTransfer[],asOf:string,currentReference:Item[],
):DayInvoiceReport{
  const byRecord=new Map(daily.records.map(row=>[row.id,row]));
  const bySource=new Map(source.map(row=>[row.transfer.number,row]));
  const movements=analyzeLieutenantMovements(source,asOf);
  const sourceLastDate=source.reduce((last,row)=>row.transfer.date>last?row.transfer.date:last,'');
  const duplicateNumbers=new Map<string,number>();
  for(const row of daily.rows){
    const key=row.branch+'|'+row.number;
    duplicateNumbers.set(key,(duplicateNumbers.get(key)||0)+1);
  }
  const rows:DayInvoiceResult[]=daily.rows.map(row=>{
    const notes:string[]=[];const postedDates=new Set<string>();
    const registered=byRecord.get(row.recordId);
    let draft:Draft|undefined;
    try{
      if(registered)draft=JSON.parse(registered.payload) as Draft;
      if(!draft?.invoices?.length||!draft.transfers)throw Error('invalid');
    }catch{notes.push('تعذّر قراءة تفاصيل الفاتورة المحفوظة.');}
    const invoice=draft?.invoices.find(item=>item.id===row.invoiceId);
    if(!invoice)notes.push('الفاتورة غير موجودة في سجل المجموعة.');
    if(!invoice?.complete)notes.push('الفاتورة الورقية غير مؤكدة الاكتمال.');
    if(duplicateNumbers.get(row.branch+'|'+row.number)!>1)
      notes.push('رقم الفاتورة مكرر في السجل؛ لا تجمع كمياتها مرتين.');
    if(row.unresolvedTransferNumbers.length||row.groupConfirmedTransfers.length)
      notes.push('المجموعة متعددة الصفحات وفيها ترحيلات لم يثبت توزيع بنودها على هذه الفاتورة.');
    const paper=invoice?paperQuantities(invoice):{totals:new Map<string,number>(),issues:['بيانات الفاتورة غير متاحة.']};
    notes.push(...paper.issues);
    const references=draft?.referenceSnapshot?.length?draft.referenceSnapshot:currentReference;
    if(!references.length)notes.push('مرجع ربط أصناف المؤسسة بأكواد SAP غير متاح.');
    const posted=new Map<string,number>();
    let anyTransfer=false;
    const nums=[...new Set(row.transferNumbers)];
    const page=draft?.invoices.findIndex(item=>item.id===row.invoiceId)??-1;
    for(const number of nums){
      const current=bySource.get(number);
      if(!current){
        // No SAP posting can be inferred from a saved invoice number alone.
        continue;
      }
      if(current.issues.length){
        notes.push('الترحيل '+number+' غير مكتمل في ملف SAP.');continue;
      }
      if(!current.transfer.date){
        notes.push('الترحيل '+number+' بلا تاريخ SAP مثبت.');continue;
      }
      if(current.transfer.date>asOf)continue;
      const state=movements.get(number);
      if(state?.kind==='sap-canceled'||state?.kind==='sap-cancel-doc'||
        current.cancellationState==='canceled'||current.cancellationState==='cancellation')continue;
      if(current.reverse)continue;
      if(state?.kind==='reversed')continue; // exact reversed pair, within cutoff
      const parsed=sourceLines(current);
      if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length){
        notes.push('تعذّر تدقيق بنود الترحيل '+number+'.');continue;
      }
      // Multiple numbered documents in one legacy card cannot supply trustworthy
      // row-level page allocations. Single-invoice groups still audit all docs.
      let savedLines:TransferLine[]|undefined;
      let transferId='';
      if(draft&&draft.invoices.length>1){
        const cards=draft.transfers.filter(item=>transferNumbers(item.number||'').includes(number));
        if(cards.length!==1||transferNumbers(cards[0].number||'').length!==1){
          notes.push('توزيع الترحيل '+number+' بين صفحات الفواتير غير مثبت.');continue;
        }
        transferId=cards[0].id;
        const saved=parseTransfer(cards[0].paste,{allowReverse:true});
        if(saved.issues.length||saved.excluded.length||
          signature(saved.lines)!==signature(parsed.lines)){
          notes.push('بنود الترحيل '+number+' تغيّرت عن النسخة التي وُزّعت على صفحات الفواتير.');continue;
        }
        savedLines=saved.lines;
      }
      let counted=false;
      for(const [index,line] of parsed.lines.entries()){
        if(line.to!=='011'||line.from==='011'||line.quantity<0)continue;
        if(!invoice){notes.push('بيانات الفاتورة غير متاحة.');break;}
        const item=refFor(references,line.sapCode,invoice);
        if(!item){
          notes.push('لا يوجد ربط وحيد مؤكد للصنف SAP '+line.sapCode+' بهذه الفاتورة.');continue;
        }
        let pieces:number;
        try{pieces=convert(line,item)}
        catch{notes.push('شدّة أو وزن تحويل '+line.sapCode+' إلى الحبة غير معرّف.');continue}
        if(!Number.isFinite(pieces)){notes.push('كمية محوّلة غير صالحة للصنف '+line.sapCode);continue}
        if(draft&&draft.invoices.length>1){
          const savedLine=savedLines?.[index];
          if(!savedLine){notes.push('توزيع سطر SAP غير مكتمل للترحيل '+number);continue}
          const parts=pageParts(draft,transferId,savedLine,pieces,item.code);
          if(!parts){notes.push('توزيع سطر '+line.sapCode+' بين الفواتير غير مثبت.');continue}
          pieces=parts[String(page+1)]||0;
        }
        if(pieces>epsilon){
          posted.set(item.code,(posted.get(item.code)||0)+pieces);
          counted=true;
        }
      }
      if(counted){anyTransfer=true;postedDates.add(current.transfer.date);}
    }
    const codes=new Set([...paper.totals.keys(),...posted.keys()]);
    const items=[...codes].sort().map(code=>{
      const item=references.find(ref=>ref.code===code);
      const expected=round(paper.totals.get(code)||0),actual=round(posted.get(code)||0);
      return {code,name:item?.name||'صنف مؤسسة غير معرّف',
        expected,posted:actual,difference:round(expected-actual)};
    });
    let state:DayInvoiceState='match';
    if(notes.length)state='review';
    else if(items.some(item=>item.difference< -epsilon))state='extra';
    else if(items.some(item=>item.difference>epsilon))
      state=anyTransfer?'short':'pending';
    else if([...postedDates].some(date=>date>row.date))state='late';
    // If the supplied SAP export stops before the requested as-of date,
    // future non-posting must never be advertised as a verified shortfall.
    if((state==='pending'||state==='short')&&sourceLastDate<asOf){
      state='review';
      notes.push('آخر ترحيل في كشف SAP بتاريخ '+(sourceLastDate||'غير معروف')+
        '، قبل تاريخ الفحص '+asOf+'؛ يلزم كشف محدث لإثبات عدم الترحيل.');
    }
    return {recordId:row.recordId,number:row.number,branch:row.branch,
      invoiceDate:row.date,asOf,transferNumbers:[...new Set([...nums,...row.unresolvedTransferNumbers,...row.groupConfirmedTransfers])],
      postedDates:[...postedDates].sort(),state,items,notes:[...new Set(notes)]};
  });
  return {rows,sourceLastDate};
}
