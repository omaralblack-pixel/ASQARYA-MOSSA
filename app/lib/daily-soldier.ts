import {catalogAuditReference,catalogAuditReferenceForInvoice,sharedInstitutionOptions,type AuditCatalog} from './audit-catalog';
import {auditInstitutionTransfers,auditInvoiceQuantities} from './institution-audit';
import {dateValue,digits,fils,invoiceDocumentNo,pageNumber,parseTransfer,sapReferences,transferNumbers,type Draft,type Transfer,type TransferLine} from './reconcile';

/** The invoice date, not the transfer date or the group creation date, owns the daily audit. */
export type SoldierStatus='match'|'review'|'difference';
export type SoldierSharedChoice={
  sapCode:string;sapName:string;chosen:string;
  codes:{code:string;name:string;price:number|null}[];
};
export type SoldierInvoice={
  id:string; number:string; date:string; amount:number|null; expected:number|null;
  status:SoldierStatus; reasons:string[]; transferNumbers:string[];
  quantityDifferences:number; missingPaperLines:boolean;sharedCodes:SoldierSharedChoice[];
};
export type SoldierResult={allMatched:boolean;invoices:SoldierInvoice[];scopeIssues:string[];unassigned:string[]};
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const invoiceText=(invoice:Draft['invoices'][number])=>{
  if(typeof invoice.auditLines==='string'&&invoice.auditLines.trim())return invoice.auditLines;
  return Object.entries(invoice.quantities||{}).filter(([,qty])=>String(qty).trim())
    .map(([code,qty])=>code+'\t'+qty).join('\n');
};
function transferPaste(lines:TransferLine[]){
  return lines.length ? header+'\n'+lines.map(line=>[
    line.sapCode,line.name,Math.abs(line.quantity),line.unit,line.from,line.to,
  ].join('\t')).join('\n') : '';
}
/**
 * Fail-closed invoice-by-invoice audit. Never trusts a client-supplied status
 * or treats an amount match as evidence of matching invoice item quantities.
 */
export function auditDraftWithSoldier(draft:Draft,catalog:AuditCatalog):SoldierResult {
  const reference=catalogAuditReference(catalog);
  const sharedBySap=new Map(sharedInstitutionOptions(catalog).map(row=>[row.sapCode,row]));
  const bySap=new Map(sapReferences(reference.filter(item=>item.active)).map(item=>[item.sapCode.toUpperCase(),item]));
  const scope=auditInstitutionTransfers(draft.transfers||[],reference);
  const scopeIssues=scope.issues.map(issue=>issue.message);
  const unassigned:string[]=[];
  const assigned=new Map<number,Map<string,TransferLine[]>>();
  for(const transfer of draft.transfers||[]){
    const source=parseTransfer(transfer.paste||'',{allowReverse:true});
    for(const line of source.lines){
      const item=bySap.get(line.sapCode.toUpperCase());
      if(!item)continue; // The scope auditor blocks unmatched foreign movements unless fully reversed.
      const page=draft.invoices.length===1?1:pageNumber(draft.pages?.['i:'+item.code]);
      if(page<1||page>draft.invoices.length){
        unassigned.push('ترحيل '+transfer.number+' · '+line.sapCode+' / '+item.code+' لم يُحدد له رقم فاتورة زرقاء.');
        continue;
      }
      if(!assigned.has(page))assigned.set(page,new Map());
      const map=assigned.get(page)!;
      map.set(transfer.id,[...(map.get(transfer.id)||[]),line]);
    }
  }
  const invoices=(draft.invoices||[]).map((invoice,index):SoldierInvoice=>{
    const page=index+1;
    const assignedLines=assigned.get(page)||new Map<string,TransferLine[]>();
    const selected:Transfer[]=(draft.transfers||[]).map(transfer=>({
      ...transfer,paste:transferPaste(assignedLines.get(transfer.id)||[]),
    })).filter(transfer=>transfer.paste.length>0);
    const text=invoiceText(invoice);
    const choices=invoice.sapInstitutionChoices||{};
    const sharedCodes:SoldierSharedChoice=[...new Set(selected.flatMap(transfer=>
      parseTransfer(transfer.paste,{allowReverse:true}).lines.map(line=>line.sapCode.toUpperCase())))]
      .flatMap(code=>{
        const shared=sharedBySap.get(code);
        return shared?[{...shared,chosen:choices[code]||''}]:[];
      });
    const paperCodes=new Set(text.replace(/\r/g,'').split('\n')
      .map(line=>digits(line.split('\t')[0]?.trim()||'')).filter(code=>/^\d{8}$/.test(code)));
    const sharedReasons:string[]=[];
    for(const shared of sharedCodes){
      const codes=shared.codes.map(row=>row.code);
      if(!shared.chosen){
        sharedReasons.push('يوجد صنف برقمين للمؤسسة: SAP '+shared.sapCode+' · '+codes.join(' أو ')+
          '. اختر الرقم المطبوع على هذه الفاتورة واعتمده.');
      }else if(!codes.includes(shared.chosen)){
        sharedReasons.push('الرقم المعتمد لـ '+shared.sapCode+' غير موجود ضمن رقمي المؤسسة المعرّفين.');
      }else if(!paperCodes.has(shared.chosen)){
        sharedReasons.push('اعتمدت '+shared.chosen+' للصنف '+shared.sapCode+
          ' لكنه غير موجود في بنود الفاتورة الزرقاء الملصقة.');
      }
      if(codes.filter(code=>paperCodes.has(code)).length>1)
        sharedReasons.push('الفاتورة تحتوي الرقمين للصنف '+shared.sapCode+
          '؛ يلزم توزيع بنودهما صراحة قبل اعتماد المطابقة.');
    }
    const invoiceReference=catalogAuditReferenceForInvoice(catalog,choices);
    const audited=auditInvoiceQuantities(selected,invoiceReference,text,invoice.amount||'');
    const missingPaperLines=!text.trim();
    const reasons:string[]=[];
    if(!invoiceDocumentNo(invoice.number))reasons.push('رقم الفاتورة الزرقاء غير مكتمل.');
    if(!dateValue(invoice.date||''))reasons.push('تاريخ الفاتورة الزرقاء غير صالح أو مفقود.');
    if(!invoice.complete)reasons.push('الفاتورة الورقية لم يتم تأكيد وجودها.');
    if(missingPaperLines)reasons.push('ألصق أرقام المواد وكمياتها بالحبة من الفاتورة الزرقاء؛ المبلغ وحده لا يكفي.');
    if(fils(invoice.amount||'')===null)reasons.push('مبلغ الفاتورة الزرقاء غير صالح أو مفقود.');
    if(audited.expectedTotal===null)reasons.push('لا يمكن حساب القيمة: أسعار أو أصناف SAP غير مكتملة.');
    if(!selected.length)reasons.push('لا توجد بنود SAP مسندة إلى هذه الفاتورة.');
    reasons.push(...scopeIssues,...unassigned,...sharedReasons,...audited.issues);
    const differences=audited.rows.filter(row=>Math.abs(row.difference)>0.000001);
    for(const row of differences.slice(0,25)){
      reasons.push('فرق '+row.code+' · '+row.institutionName+': SAP '+row.sapPieces+' حبة، الفاتورة '+row.invoicePieces+' حبة.');
    }
    if(audited.amountDifference!==null&&audited.amountDifference!==0)
      reasons.push('فرق مالي بقيمة '+(audited.amountDifference/1000).toFixed(3)+' دينار.');
    const hardReview=scopeIssues.length>0||unassigned.length>0||sharedReasons.length>0||missingPaperLines||
      audited.issues.length>0||audited.expectedTotal===null||!selected.length||
      !invoiceDocumentNo(invoice.number)||!dateValue(invoice.date||'')||!invoice.complete||
      fils(invoice.amount||'')===null;
    const status:SoldierStatus=hardReview?'review'
      :audited.status==='difference'||audited.amountDifference!==0?'difference'
      :audited.status==='match'&&reasons.length===0?'match':'review';
    return {
      id:invoice.id,number:invoiceDocumentNo(invoice.number)||'',date:dateValue(invoice.date||'')||'',
      amount:audited.invoiceTotal,expected:audited.expectedTotal,status,
      reasons:[...new Set(reasons)].slice(0,60),
      transferNumbers:[...new Set((draft.transfers||[])
        .filter(transfer=>assignedLines.has(transfer.id)).flatMap(transfer=>transferNumbers(transfer.number)))],
      quantityDifferences:differences.length,missingPaperLines,sharedCodes,
    };
  });
  return {allMatched:invoices.length>0&&scope.valid&&unassigned.length===0&&invoices.every(row=>row.status==='match'),
    invoices,scopeIssues,unassigned};
}

export function dailySoldierRows(records:{id:string;branch:string;payload:string}[],
  catalog:AuditCatalog,dateInput:string) {
  const date=dateValue(dateInput);
  if(!date)throw Error('أدخل تاريخ الفاتورة الزرقاء بصيغة يوم.شهر.سنة أو اختره من التقويم.');
  const rows:{recordId:string;branch:string;invoice:SoldierInvoice}[]=[];
  for(const record of records){
    let draft:Draft;
    try{draft=JSON.parse(record.payload) as Draft}catch{continue}
    if(!Array.isArray(draft.invoices)||!draft.invoices.some(row=>dateValue(row.date||'')===date))continue;
    const check=auditDraftWithSoldier(draft,catalog);
    for(const invoice of check.invoices)if(invoice.date===date)rows.push({
      recordId:record.id,branch:record.branch,invoice,
    });
  }
  rows.sort((a,b)=>a.invoice.number.localeCompare(b.invoice.number,'en'));
  return {date,rows,counts:{
    total:rows.length,matched:rows.filter(row=>row.invoice.status==='match').length,
    differences:rows.filter(row=>row.invoice.status==='difference').length,
    review:rows.filter(row=>row.invoice.status==='review').length,
  }};
}
