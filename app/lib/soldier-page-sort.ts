import {catalogAuditReference,sharedInstitutionOptions,type AuditCatalog} from './audit-catalog';
import {convert,digits,numeric,parseTransfer,sapReferences,soldierLineKey,type Draft,type TransferLine} from './reconcile';

export type PageSortIssue={
 key:string;sapCode:string;transfer:string;totalPieces:number;
 candidates:number[];reason:string;
};
export type SortedPageLine={
 page:number;invoiceNumber:string;transferNumber:string;sapCode:string;
 institutionCode:string;institutionName:string;pieces:number;price:number|null;value:number|null;
};
export type PageSortSummary={
 draft:Draft;assigned:number;split:number;unresolved:PageSortIssue[];
 pageCounts:number[];lines:SortedPageLine[];
};
export {soldierLineKey} from './reconcile';

const epsilon=0.000001;
const same=(a:number,b:number)=>Math.abs(a-b)<epsilon;
const paperRows=(invoice:Draft['invoices'][number])=>{
 const counts=new Map<string,number>();
 const text=invoice.auditLines?.trim()
   ?invoice.auditLines
   :Object.entries(invoice.quantities||{}).map(([code,q])=>code+'\t'+q).join('\n');
 for(const line of text.replace(/\r/g,'').split('\n')){
   if(!line.trim())continue;
   const [rawCode,rawQuantity]=line.split('\t').map(x=>x.trim());
   const code=digits(rawCode||'');
   if(!/^\d{8}$/.test(code))continue;
   const qty=numeric(rawQuantity);
   if(qty===null||qty<0)continue;
   counts.set(code,(counts.get(code)||0)+qty);
 }
 return counts;
};
type Row={key:string;sapCode:string;transfer:string;line:TransferLine;
 code:string;absPieces:number;candidates:number[]};
type Allocation=Record<string,number>;
const sum=(a:Allocation)=>Object.values(a).reduce((s,v)=>s+v,0);
const meaningful=(a:Allocation)=>Object.fromEntries(Object.entries(a).filter(([,pieces])=>pieces>epsilon));
/** A per-row distribution in pieces. Its sum MUST equal that transfer row's pieces. */
export function soldierLineParts(draft:Draft,transferId:string,line:TransferLine,totalPieces:number,
 defaultCode:string):Allocation{
 const key=soldierLineKey(transferId,line);
 const explicit=draft.soldierLineAllocations?.[key];
 if(explicit!==undefined){
   const entries=Object.entries(explicit);
   if(!entries.length||entries.some(([page,pieces])=>!/^\d+$/.test(page)||
     +page<1||+page>draft.invoices.length||typeof pieces!=='number'||
     !Number.isFinite(pieces)||pieces<=0)||!same(sum(explicit),Math.abs(totalPieces)))return {};
   return explicit;
 }
 if(draft.soldierLineAllocations!==undefined)return {}; // Explicit sorted state: no guessed fallback.
 const fallback=draft.invoices.length===1?1:
   Number(draft.pages?.['i:'+defaultCode]||draft.pages?.['s:'+line.sapCode]||0);
 if(!Number.isSafeInteger(fallback)||fallback<1||fallback>draft.invoices.length)return {};
 return {[String(fallback)]:Math.abs(totalPieces)};
}

/** Deterministic classification from each blue invoice's actual item codes and quantities.
 * Never assigns by invoice amount alone; repeated SKU across different SAP transfers
 * requires unique quantity evidence or an explicit human split/selection.
 */
export function sortSoldierInvoicePages(draft:Draft,catalog:AuditCatalog):PageSortSummary{
 const reference=catalogAuditReference(catalog);
 const bySap=new Map(sapReferences(reference.filter(r=>r.active)).map(r=>[r.sapCode.toUpperCase(),r]));
 const shared=new Map(sharedInstitutionOptions(catalog).map(r=>[r.sapCode.toUpperCase(),r]));
 const papers=draft.invoices.map(paperRows);
 const items:Row[]=[];
 const unresolved:PageSortIssue[]=[];
 const allocations:Record<string,Allocation>={};
 const totals:Record<string,number>={};
 const originalManual=new Set(draft.soldierManualLineKeys||[]);
 const grouped=new Map<string,Row[]>();
 for(const transfer of draft.transfers){
   for(const line of parseTransfer(transfer.paste,{allowReverse:true}).lines){
     const key=soldierLineKey(transfer.id,line),sapCode=line.sapCode.toUpperCase();
     const item=bySap.get(sapCode);
     if(!item||!item.sapUnit)continue;
     let pieces:number;
     try{pieces=convert(line,item)}catch{continue}
     if(!Number.isFinite(pieces)||Math.abs(pieces)<epsilon)continue;
     const alias=shared.get(sapCode);
     const candidates=papers.flatMap((paper,i)=>{
       const chosen=draft.invoices[i].sapInstitutionChoices?.[sapCode];
       const code=alias?chosen:item.code;
       if(alias&&(!chosen||!alias.codes.some(r=>r.code===chosen)))return [];
       return code&&paper.has(code)?[i+1]:[];
     });
     const row:Row={key,sapCode,transfer:transfer.number,line,code:item.code,
       absPieces:Math.abs(pieces),candidates};
     items.push(row);
     totals[key]=Math.abs(pieces);
     grouped.set(sapCode,[...(grouped.get(sapCode)||[]),row]);
   }
 }
 const demand=(row:Row,page:number)=>{
   const code=draft.invoices[page-1].sapInstitutionChoices?.[row.sapCode]||row.code;
   return papers[page-1]?.get(code)||0;
 };
 const assignedFor=(row:Row,page:number)=>
   Object.entries(allocations).reduce((total,[key,parts])=>{
     const existing=items.find(x=>x.key===key);
     if(existing?.sapCode===row.sapCode)return total+
       (existing.line.quantity>=0?1:-1)*(parts[String(page)]||0);
     return total;
   },0);
 const set=(row:Row,parts:Allocation)=>{
   allocations[row.key]=meaningful(parts);
 };
 const problem=(row:Row,reason:string)=>{
   unresolved.push({key:row.key,sapCode:row.sapCode,transfer:row.transfer,
     totalPieces:row.absPieces,candidates:row.candidates,reason});
 };
 // Preserve only explicitly approved row distributions, provided their sum is still exact.
 for(const row of items){
   if(!originalManual.has(row.key))continue;
   const parts=draft.soldierLineAllocations?.[row.key];
   if(parts&&Object.keys(parts).every(page=>row.candidates.includes(Number(page)))&&
     Object.values(parts).every(p=>Number.isFinite(p)&&p>0)&&same(sum(parts),row.absPieces)){
     set(row,parts);
   }else problem(row,'التوزيع اليدوي القديم لم يعد يطابق سطر SAP أو صفحات الفواتير؛ أعد اعتماده.');
 }
 for(const group of grouped.values()){
   const pending=group.filter(row=>!allocations[row.key]);
   if(!pending.length)continue;
   const onePage=[...new Set(group.flatMap(row=>row.candidates))];
   if(onePage.length===1&&pending.every(row=>row.candidates.includes(onePage[0]))){
     for(const row of pending)set(row,{[onePage[0]]:row.absPieces});
     continue;
   }
   if(group.some(row=>row.line.quantity<0)){
     for(const row of pending)problem(row,'الصنف موجود على أكثر من فاتورة وله حركة عكسية؛ يلزم توزيع معتمد لكل سطر من الترحيلات.');
     continue;
   }
   const distinctTransfers=new Set(group.map(row=>row.transfer));
   const canAutopartition=distinctTransfers.size===1&&group.every(row=>row.candidates.length>0);
   const neededPages=[...new Set(group.flatMap(row=>row.candidates))].sort((a,b)=>a-b);
   const allDemand=neededPages.reduce((v,page)=>v+demand(group[0],page),0);
   const allSupply=group.reduce((v,row)=>v+row.absPieces,0);
   if(canAutopartition&&neededPages.length>1&&same(allDemand,allSupply)){
     const remaining=new Map(neededPages.map(page=>[page,Math.max(0,demand(group[0],page)-assignedFor(group[0],page))]));
     for(const row of pending){
       let left=row.absPieces;
       const parts:Allocation={};
       for(const page of row.candidates){
         const qty=Math.min(left,Math.max(0,remaining.get(page)||0));
         if(qty>epsilon){parts[String(page)]=qty;remaining.set(page,(remaining.get(page)||0)-qty);left-=qty;}
       }
       if(same(left,0))set(row,parts);
       else problem(row,'الكميات المثبتة للصفحات لا تستوعب سطر الترحيل كاملًا.');
     }
     continue;
   }
   // Across multiple source transfers, only a unique quantity fit is provable.
   const working=[...pending].sort((a,b)=>b.absPieces-a.absPieces);
   for(const row of working){
     const perfect=row.candidates.filter(page=>same(demand(row,page)-assignedFor(row,page),row.absPieces));
     const possible=row.candidates.filter(page=>demand(row,page)-assignedFor(row,page)+epsilon>=row.absPieces);
     const chosen=perfect.length===1?perfect[0]:perfect.length===0&&possible.length===1?possible[0]:0;
     if(chosen)set(row,{[chosen]:row.absPieces});
     else problem(row,row.candidates.length===0?
       'رقم الصنف غير موجود على صفحات الفواتير أو يحتاج اختيار رقم المؤسسة المزدوج.':
       row.candidates.length>1?
       'الصنف موجود على عدة فواتير؛ لا يمكن إثبات صفحة هذا الترحيل دون تحديد الكمية لكل صفحة.':
       'كمية SAP أكبر من الكمية المتبقية لهذه الفاتورة أو هناك فرق في الكميات.');
   }
 }
 const lines:SortedPageLine[]=[];
 const byInstitution=new Map(catalog.institution.map(row=>[row.code,row]));
 for(const row of items){
   const parts=allocations[row.key];
   if(!parts)continue;
   for(const [pageText,pieces] of Object.entries(parts)){
     const page=Number(pageText);
     const code=draft.invoices[page-1].sapInstitutionChoices?.[row.sapCode]||row.code;
     const named=byInstitution.get(code);
     const signed=row.line.quantity<0?-pieces:pieces;
     lines.push({page,invoiceNumber:draft.invoices[page-1].number,
       transferNumber:row.transfer,sapCode:row.sapCode,institutionCode:code,
       institutionName:named?.name||code,pieces:signed,price:named?.price??null,
       value:named?.price===null||!named?null:Math.round(signed*named.price)});
   }
 }
 const pages={...draft.pages};
 const codePages=new Map<string,Set<string>>();
 for(const row of items){
   const parts=allocations[row.key];
   if(!parts)continue;
   const setPages=codePages.get(row.code)||new Set<string>();
   Object.keys(parts).forEach(page=>setPages.add(page));
   codePages.set(row.code,setPages);
 }
 for(const [code,assigned] of codePages){
   if(!grouped.size)continue;
   const related=items.filter(row=>row.code===code);
   if(related.every(row=>allocations[row.key])&&assigned.size===1)
     pages['i:'+code]=[...assigned][0];
   else if(assigned.size>1)delete pages['i:'+code];
 }
 const next={...draft,pages,soldierLineAllocations:allocations,soldierLineTotals:totals,
   soldierManualLineKeys:[...originalManual].filter(key=>!!allocations[key])};
 return {draft:next,assigned:Object.keys(allocations).length,
   split:Object.values(allocations).filter(parts=>Object.keys(parts).length>1).length,
   unresolved,lines,pageCounts:draft.invoices.map((_,i)=>Object.values(allocations)
     .filter(parts=>parts[String(i+1)]>0).length)};
}
