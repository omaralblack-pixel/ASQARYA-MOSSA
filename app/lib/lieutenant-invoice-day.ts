import {convert,invoiceDocumentNo,numeric,parseTransfer,sapReferences,soldierLineKey,transferNumbers,
  type Draft,type Item,type TransferLine} from './reconcile';
import type {CollectedInvoice} from './invoice-collector';
import type {LieutenantTransfer} from './lieutenant';
import {analyzeLieutenantMovements,isCashVanTransfer} from './lieutenant-counterparts';

export type DayInvoiceState='match'|'late'|'pending'|'short'|'extra'|'review'|'cashvan-settled'|'cashvan-pending';
export type DayInvoiceRecord={id:string;branch:string;status:string;payload:string};
export type DayInvoiceData={
  rows:CollectedInvoice[];records:DayInvoiceRecord[];
  unreadableRecords:number;undatedInvoices:number;inferredDates:number;
};
export type DayItemResult={code:string;name:string;expected:number|null;posted:number|null;difference:number|null};
export type DayInvoiceResult={
  recordId:string;number:string;branch:string;invoiceDate:string;asOf:string;
  transferNumbers:string[];postedDates:string[];state:DayInvoiceState;
  financiallyMatchedGroup:boolean;items:DayItemResult[];notes:string[];
  cashVan?:boolean;reverseNumbers?:string[];
};
export type DayInvoiceReport={rows:DayInvoiceResult[];sourceLastDate:string;};
const epsilon=0.000001;
const near=(a:number,b:number)=>Math.abs(a-b)<epsilon;
const round=(n:number)=>Number(n.toFixed(6));
const signature=(lines:TransferLine[])=>lines.map(line=>[
  line.sapCode,line.quantity.toFixed(6),line.unit,line.from,line.to].join('|')).join('||');
const sourceLines=(row:LieutenantTransfer)=>parseTransfer(row.transfer.paste,{allowReverse:true});
// SAP correction rows can have negative Quantity. The normal reconciliation
// parser deliberately rejects negatives, so read those rows separately.
function correctionLines(row:LieutenantTransfer){
  if(row.reverse)return sourceLines(row);
  const result:{lines:TransferLine[];issues:string[];excluded:string[]}={lines:[],issues:[],excluded:[]};
  for(const [index,text] of row.transfer.paste.replace(/\r/g,'').split('\n').slice(1).entries()){
    if(!text.trim())continue;
    const [rawCode,name,rawQty,unit,from,to]=text.split('\t');
    const sapCode=(rawCode||'').toUpperCase();
    const quantity=Number((rawQty||'').replace(/,/g,''));
    if(!/^[A-Z]{2,6}\d{3,10}$/.test(sapCode)||!Number.isFinite(quantity)||
      !['Piece','Carton','KG'].includes(unit)||!from||!to||from==='011'&&to==='011'){
      result.issues.push('سطر تصحيح SAP غير صالح: '+(index+2));continue;
    }
    result.lines.push({row:index+2,sapCode,name:name||'',quantity,unit,from,to});
  }
  if(!result.lines.length)result.issues.push('لا توجد بنود تصحيح صالحة.');
  return result;
}
const paperQuantities=(invoice:Draft['invoices'][number])=>{
  const totals=new Map<string,number>(),issues:string[]=[];
  const source=invoice.auditLines?.trim()?
    invoice.auditLines:
    Object.entries(invoice.quantities||{}).map(([code,quantity])=>code+'\t'+quantity).join('\n');
  if(!source.trim())return {totals,issues:['أصناف وكميات الفاتورة الورقية غير مسجلة في السجل.']};
  for(const line of source.replace(/\r/g,'').split('\n')){
    if(!line.trim())continue;
    const fields=line.split('\t').map(field=>field.trim());
    const code=fields[0]?.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))||'';
    if(!/^\d{8}$/.test(code)){
      if(/^(?:رقم\s*(?:المادة|الصنف)|item\s*(?:no|code)|code)/i.test(fields[0]||''))continue;
      issues.push('يوجد سطر في الفاتورة بلا رقم صنف مؤسسة صالح.');continue;
    }
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
 * A saved operator approval is authoritative for the invoice status. Missing
 * quantity/page details remain unknown, without reopening that approval.
 * Unapproved invoices still require independently verifiable quantities.
 */
export function auditInvoicesForDay(
  daily:DayInvoiceData,source:LieutenantTransfer[],asOf:string,currentReference:Item[],
):DayInvoiceReport{
  const byRecord=new Map(daily.records.map(row=>[row.id,row]));
  const bySource=new Map(source.map(row=>[row.transfer.number,row]));
  const movements=analyzeLieutenantMovements(source,asOf);
  const cancelRef=/inventory\s+transfer\s+no\.?\s*(\d{4,20})\s+has\s+been\s+cancel(?:ed|led)/i;
  const reverseRef=/(?:عكس(?:ي)?(?:\s+ترحيل)?|ترحيل\s+عكسي(?:\s+لترحيل)?|reverse(?:\s+(?:transfer|of))?)\s*(?:رقم|no\.?|#|:|-)?\s*(\d{4,20})/iu;
  const cancellationDates=new Map<string,string>();
  const corrective=new Map<string,LieutenantTransfer[]>();
  for(const movement of source){
    const related=movement.remarks.match(cancelRef)?.[1];
    if(movement.cancellationState==='cancellation'&&related&&movement.transfer.date){
      const saved=cancellationDates.get(related);
      if(!saved||movement.transfer.date<saved)cancellationDates.set(related,movement.transfer.date);
    }
    const original=related||(movement.reverse?movement.remarks.match(reverseRef)?.[1]:undefined);
    if(!original||!bySource.has(original)||original===movement.transfer.number)continue;
    if((movement.signedAdjustment||movement.reverse)&&
      movement.cancellationState!=='canceled'&&movement.cancellationState!=='cancellation'){
      corrective.set(original,[...(corrective.get(original)||[]),movement]);
    }
  }
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
    // The operator has already checked and accepted this record. Respect the
    // current saved status; a stale payload summary must not override it.
    const savedStatus=registered?.status||
      (draft as (Draft&{summary?:{status?:string}})|undefined)?.summary?.status;
    const financiallyMatchedGroup=savedStatus==='match';
    // Cash Van is a stock movement that must be settled by reverse/cancellation,
    // NOT a missing blue invoice. Do not demand paper lines or fabricate zeroes.
    // Only apply when SAP itself identifies the incoming movement as Cash Van
    // and there is no valid saved blue invoice number.
    const allNumbers=[...new Set([
      ...row.transferNumbers,...row.unresolvedTransferNumbers,...row.groupConfirmedTransfers,
    ])];
    const cashSources=allNumbers.map(number=>bySource.get(number)).filter(
      (item):item is LieutenantTransfer=>!!item&&isCashVanTransfer(item)&&!item.reverse);
    if(!invoiceDocumentNo(row.number)&&cashSources.length>0){
      const cashNotes=['هذه حركة كاش فان وليست فاتورة زرقاء؛ المطلوب عكسي مطابق أو إلغاء SAP موثق.'];
      const reverseNumbers=[...new Set(cashSources.flatMap(item=>{
        const movement=movements.get(item.transfer.number);
        return movement?.kind==='reversed'||movement?.kind==='cashvan-pending'?
          movement.counterparts||[movement.counterpart].filter((value):value is string=>!!value):[];
      }))];
      const allPresent=allNumbers.length===cashSources.length;
      const settled=allPresent&&cashSources.every(item=>{
        const movement=movements.get(item.transfer.number);
        return item.transfer.date<=asOf&&(
          movement?.kind==='reversed'||
          movement?.kind==='sap-canceled'&&!!movement.counterpartDate&&
            movement.counterpartDate<=asOf);
      });
      for(const item of cashSources){
        const movement=movements.get(item.transfer.number);
        if(movement?.note)cashNotes.push(item.transfer.number+': '+movement.note);
        if(item.transfer.date>asOf)
          cashNotes.push('الترحيل '+item.transfer.number+' بعد تاريخ الفحص '+asOf+'.');
      }
      if(!allPresent)
        cashNotes.push('بعض الترحيلات المرتبطة غير موجودة أو ليست كاش فان مؤكدًا في كشف SAP؛ لا يمكن اعتماد تسوية المجموعة.');
      if(!settled)
        cashNotes.push('التسوية الكاملة غير مثبتة حتى '+asOf+'؛ لا تعتبرها ملغاة أو مسوّاة قبل إثبات كل الكميات.');
      return {recordId:row.recordId,number:row.number,branch:row.branch,
        invoiceDate:row.date,asOf,transferNumbers:allNumbers,
        postedDates:[...new Set(cashSources.map(item=>item.transfer.date)
          .filter(date=>!!date&&date<=asOf))].sort(),
        state:settled?'cashvan-settled':'cashvan-pending',financiallyMatchedGroup:false,
        items:[],notes:cashNotes,cashVan:true,reverseNumbers};
    }
    if(!invoice)notes.push('الفاتورة غير موجودة في سجل المجموعة.');
    if(!invoice?.complete)notes.push('الفاتورة الورقية غير مؤكدة الاكتمال.');
    if(duplicateNumbers.get(row.branch+'|'+row.number)!>1)
      notes.push('رقم الفاتورة مكرر في السجل؛ لا تجمع كمياتها مرتين.');
    if(row.unresolvedTransferNumbers.length||row.groupConfirmedTransfers.length)
      notes.push('المجموعة متعددة الصفحات وفيها ترحيلات لم يثبت توزيع بنودها على هذه الفاتورة.');
    const paper=invoice?paperQuantities(invoice):{totals:new Map<string,number>(),issues:['بيانات الفاتورة غير متاحة.']};
    notes.push(...paper.issues);
    // Missing/partially readable paper quantities are unknown, NEVER zero.
    const paperKnown=!!invoice?.complete&&paper.issues.length===0&&paper.totals.size>0;
    const references=draft?.referenceSnapshot?.length?draft.referenceSnapshot:currentReference;
    if(!references.length)notes.push('مرجع ربط أصناف المؤسسة بأكواد SAP غير متاح.');
    const posted=new Map<string,number>();
    let anyTransfer=false;
    const nums=[...new Set(row.transferNumbers)];
    let postedKnown=!!invoice&&!row.unresolvedTransferNumbers.length&&
      !row.groupConfirmedTransfers.length;
    const page=draft?.invoices.findIndex(item=>item.id===row.invoiceId)??-1;
    for(const number of nums){
      const current=bySource.get(number);
      if(!current){
        // No SAP posting can be inferred from a saved invoice number alone.
        postedKnown=false;
        notes.push('الترحيل '+number+' غير موجود في كشف SAP الحالي.');
        continue;
      }
      if(current.issues.length){
        postedKnown=false;notes.push('الترحيل '+number+' غير مكتمل في ملف SAP.');continue;
      }
      if(!current.transfer.date){
        postedKnown=false;notes.push('الترحيل '+number+' بلا تاريخ SAP مثبت.');continue;
      }
      if(current.transfer.date>asOf)continue;
      const state=movements.get(number);
      if(current.cancellationState==='cancellation'||state?.kind==='sap-cancel-doc')continue;
      const canceledAt=cancellationDates.get(number);
      const canceledNow=current.cancellationState==='canceled'||state?.kind==='sap-canceled';
      if(canceledNow&&(!canceledAt||canceledAt<=asOf)){
        if(!canceledAt&&asOf<sourceLastDate)
          notes.push('الترحيل '+number+' ملغي حاليًا، لكن تاريخ إلغائه غير مثبت لفحص يوم '+asOf+'.');
        continue;
      }
      if(current.reverse)continue;
      if(state?.kind==='reversed')continue; // Full exact reverse within cutoff; net incoming is zero.
      const parsed=sourceLines(current);
      if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length){
        postedKnown=false;notes.push('تعذّر تدقيق بنود الترحيل '+number+'.');continue;
      }
      // Multiple numbered documents in one legacy card cannot supply trustworthy
      // row-level page allocations. Single-invoice groups still audit all docs.
      let savedLines:TransferLine[]|undefined;
      let transferId='';
      if(draft&&draft.invoices.length>1){
        const cards=draft.transfers.filter(item=>transferNumbers(item.number||'').includes(number));
        if(cards.length!==1||transferNumbers(cards[0].number||'').length!==1){
          postedKnown=false;notes.push('توزيع الترحيل '+number+' بين صفحات الفواتير غير مثبت.');continue;
        }
        transferId=cards[0].id;
        const saved=parseTransfer(cards[0].paste,{allowReverse:true});
        if(saved.issues.length||saved.excluded.length||
          signature(saved.lines)!==signature(parsed.lines)){
          postedKnown=false;
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
          postedKnown=false;
          notes.push('لا يوجد ربط وحيد مؤكد للصنف SAP '+line.sapCode+' بهذه الفاتورة.');continue;
        }
        let pieces:number;
        try{pieces=convert(line,item)}
        catch{postedKnown=false;notes.push('شدّة أو وزن تحويل '+line.sapCode+' إلى الحبة غير معرّف.');continue}
        if(!Number.isFinite(pieces)){postedKnown=false;notes.push('كمية محوّلة غير صالحة للصنف '+line.sapCode);continue}
        if(draft&&draft.invoices.length>1){
          const savedLine=savedLines?.[index];
          if(!savedLine){postedKnown=false;notes.push('توزيع سطر SAP غير مكتمل للترحيل '+number);continue}
          const parts=pageParts(draft,transferId,savedLine,pieces,item.code);
          if(!parts){postedKnown=false;notes.push('توزيع سطر '+line.sapCode+' بين الفواتير غير مثبت.');continue}
          pieces=parts[String(page+1)]||0;
        }
        if(pieces>epsilon){
          posted.set(item.code,(posted.get(item.code)||0)+pieces);
          counted=true;
        }
      }
      if(counted){anyTransfer=true;postedDates.add(current.transfer.date);}
      // A partially signed SAP cancellation, or an explicitly linked partial
      // reverse, reduces the posted quantity. No inference from item coincidence.
      if(draft?.invoices.length===1){
        for(const correction of corrective.get(number)||[]){
          if(!correction.transfer.date||correction.transfer.date>asOf||correction.issues.length)continue;
          const adjusted=correctionLines(correction);
          if(adjusted.issues.length||adjusted.excluded.length||!adjusted.lines.length){
            postedKnown=false;notes.push('حركة التصحيح '+correction.transfer.number+' غير قابلة للتحقق.');continue;
          }
          const hasPositive=adjusted.lines.some(line=>line.quantity>=0);
          if(hasPositive){postedKnown=false;notes.push('حركة التصحيح '+correction.transfer.number+' ليست حركة خصم صافية.');continue;}
          const originalAmounts=new Map<string,number>();
          for(const line of parsed.lines){
            if(line.quantity<=0)continue;
            const key=[line.sapCode,line.unit,line.from,line.to].join('|');
            originalAmounts.set(key,(originalAmounts.get(key)||0)+line.quantity);
          }
          const spent=new Map<string,number>();
          let valid=true;
          for(const line of adjusted.lines){
            const key=[line.sapCode,line.unit,
              correction.reverse?line.to:line.from,
              correction.reverse?line.from:line.to].join('|');
            const amount=Math.abs(line.quantity);
            const used=(spent.get(key)||0)+amount;
            spent.set(key,used);
            if(!originalAmounts.has(key)||used>originalAmounts.get(key)!+epsilon)valid=false;
          }
          if(!valid){postedKnown=false;notes.push('التصحيح '+correction.transfer.number+' لا يتطابق مع الصنف والاتجاه والكمية الأصلية.');continue;}
          for(const line of adjusted.lines){
            const item=invoice?refFor(references,line.sapCode,invoice):null;
            if(!item){postedKnown=false;notes.push('تعريف صنف تصحيح '+line.sapCode+' غير مكتمل.');continue;}
            try{
              const absolute={...line,quantity:Math.abs(line.quantity)};
              const pieces=convert(absolute,item);
              posted.set(item.code,(posted.get(item.code)||0)-pieces);
            }catch{postedKnown=false;notes.push('شدّة تصحيح '+line.sapCode+' غير معرّفة.');}
          }
          postedDates.add(correction.transfer.date);
        }
      }else if((corrective.get(number)||[]).some(correction=>correction.transfer.date<=asOf)){
        postedKnown=false;
        notes.push('يوجد عكسي أو تصحيح جزئي لترحيل متعدد الصفحات؛ يلزم تحديد الصفحة المتأثرة قبل اعتماد كميتها.');
      }
    }
    const codes=new Set([...paper.totals.keys(),...posted.keys()]);
    const items=[...codes].sort().map(code=>{
      const item=references.find(ref=>ref.code===code);
      const expected=paperKnown?round(paper.totals.get(code)||0):null;
      const actual=postedKnown?round(posted.get(code)||0):null;
      return {code,name:item?.name||'صنف مؤسسة غير معرّف',
        expected,posted:actual,
        difference:expected!==null&&actual!==null?round(expected-actual):null};
    });
    if(financiallyMatchedGroup){
      notes.unshift('مطابقة حسب اعتمادك المالي المحفوظ؛ لا يُطلب إعادة إدخال الكميات أو توزيع الصفحات.');
      // Receipt dates can be read without inventing a quantity allocation.
      // Legacy shared transfers stay group links and never add duplicate items.
      const linkedNumbers=[...new Set([...nums,...row.unresolvedTransferNumbers,...row.groupConfirmedTransfers])];
      for(const number of linkedNumbers){
        const current=bySource.get(number);
        if(!current?.transfer.date)continue;
        if(current.transfer.date>asOf){
          notes.push('الترحيل '+number+' بتاريخ '+current.transfer.date+' بعد تاريخ الفحص؛ لم تدخل كمياته في الفحص.');
          continue;
        }
        const movement=movements.get(number);
        const canceledAt=cancellationDates.get(number);
        const canceledNow=current.cancellationState==='canceled'||movement?.kind==='sap-canceled';
        if(current.cancellationState==='cancellation'||movement?.kind==='sap-cancel-doc'||
          current.reverse||current.signedAdjustment||movement?.kind==='reversed'||
          canceledNow&&(!canceledAt||canceledAt<=asOf))continue;
        postedDates.add(current.transfer.date);
      }
    }
    let state:DayInvoiceState='match';
    if(financiallyMatchedGroup){
      state=[...postedDates].some(date=>date>row.date)?'late':'match';
    }else if(notes.length)state='review';
    else if(items.some(item=>item.difference!==null&&item.difference< -epsilon))state='extra';
    else if(items.some(item=>item.difference!==null&&item.difference>epsilon))
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
      postedDates:[...postedDates].sort(),state,financiallyMatchedGroup:!!financiallyMatchedGroup,
      items,notes:[...new Set(notes)]};
  });
  return {rows,sourceLastDate};
}
