import {classifyLieutenantContent,parseLieutenantStock} from './lieutenant-stock';
import {isUnifiedSapSource,splitUnifiedSapSource} from './unified-sap-query';
import {parseLieutenantTransfers} from './lieutenant';
import {lieutenantImportPlan} from './lieutenant-import-plan';
import {readAqabaOfficial,readAqabaTransfers,readAqabaJournal} from './aqaba';

export const sapProcessorVersion=1;
export const sapKinds={unified:'الكويري الشامل — SAP 011',transfers:'جميع ترحيلات SAP من وإلى 011',opening:'رصيد 011 الافتتاحي الفعلي',balance:'رصيد 011 الفعلي بنهاية الفترة',official:'فواتير ومستندات SAP الرسمية — العقبة',inventory:'حركات المخزون والإلغاءات OINM',aqabaTransfer:'ترحيلات SAP بتنسيق العقبة',monthly:'كشف أرقام ترحيلات M2026',other:'كشف SAP مساعد — غير معروف'};
export type SapKind=keyof typeof sapKinds;
export type SapBatch={action:string;items:unknown[]};
export type SapPlan={kind:SapKind;issues:string[];documents:{number:string;state:string;reason:string}[];batches:SapBatch[];count:number};
const headers=(text:string)=>text.replace(/^\uFEFF/,'').split(/\r?\n/).find(x=>x.trim())?.toLowerCase().replace(/[\s._-]+/g,'')||'';
export function classifySapFile(text:string):SapKind{
 const h=headers(text);
 if(isUnifiedSapSource(text))return 'unified';
 if(h.includes('transnum')||h.includes('معرفحركةالمخزون'))return 'inventory';
 if((h.includes('نوعالمستند')||h.includes('documenttype'))&&(h.includes('رقمالزبون')||h.includes('cardcode')||h.includes('customercode')))return 'official';
 const kind=classifyLieutenantContent(text);
 if(kind!=='other')return kind;
 // This SAP export uses different aliases and row-level keys from the 011 export.
 if(readAqabaTransfers(text).items.length)return 'aqabaTransfer';
 if((h.includes('documentnumber')||h.includes('رقمالترحيل')||h.includes('docnum'))&&(h.includes('documentdate')||h.includes('تاريخالترحيل')||h.includes('docdate')))return 'monthly';
 return 'other';
}
export function buildSapBatches(action:string,items:unknown[]):SapBatch[]{
 const batches:SapBatch[]=[];let current:unknown[]=[],size=0;
 for(const item of items){
  const bytes=new TextEncoder().encode(JSON.stringify(item)).length+1;
  if(bytes>1_700_000)throw Error('مستند واحد يتجاوز حد المعالجة الآمن. الأصل محفوظ؛ راجع المستند.');
  if(current.length&&(current.length>=50||size+bytes>600_000)){batches.push({action,items:current});current=[];size=0;}
  current.push(item);size+=bytes;
 }
 if(current.length)batches.push({action,items:current});
 return batches;
}
export function buildSapPlan(text:string,branches:string[]):SapPlan{
 const kind=classifySapFile(text);
 if(kind==='unified'){
  const parts=splitUnifiedSapSource(text);
  const issues:string[]=[],documents:SapPlan['documents']=[],batches:SapBatch[]=[];
  let count=0;
  // Reuse the existing transfer importer so its invoice, cancellation and
  // duplicate protections remain authoritative.
  if(parts.counts.TRANSFER){
   const plan=buildSapPlan(parts.transfers,branches);
   issues.push(...plan.issues);documents.push(...plan.documents);
   batches.push(...plan.batches.filter(x=>x.action==='lieutenantImport'));
   // Aqaba assignments demand explicit branch evidence, never an inference
   // from a shared warehouse.
   const aqaba=readAqabaTransfers(parts.transfers);
   const documented=aqaba.items.filter(x=>x.classified==='aqaba-remark');
   batches.push(...buildSapBatches('aqabaTransfer',documented));
   count+=plan.count;
  }
  if(parts.counts.OFFICIAL){
   const official=readAqabaOfficial(parts.official);
   issues.push(...official.issues);
   batches.push(...buildSapBatches('aqabaOfficial',official.items));
   count+=official.items.length;
  }
  if(parts.counts.OINM){
   const journal=readAqabaJournal(parts.journal);
   issues.push(...journal.issues);
   batches.push(...buildSapBatches('aqabaJournal',journal.items));
   count+=journal.items.length;
  }
  const opening=parseLieutenantStock(parts.opening,'opening'),
    closing=parseLieutenantStock(parts.closing,'balance');
  issues.push(...opening.issues,...closing.issues);
  count+=opening.items.length+closing.items.length;
  // The physical stock snapshots are archived by the file-center client
  // separately with the actual query dates (never upload timestamps).
  return {kind,issues:[...new Set(issues)],documents,batches,count};
 }
 if(kind==='transfers'){
  const scan=parseLieutenantTransfers(text,branches);
  const documents=lieutenantImportPlan(scan.transfers,'0001-01-01','9999-12-31');
  const wanted=new Set(documents.filter(x=>x.state==='pending').map(x=>x.number));
  const items=scan.transfers.filter(x=>wanted.has(x.transfer.number)).map(x=>({
   number:x.transfer.number,date:x.transfer.date,paste:x.transfer.paste,branch:x.branch,remarks:x.remarks,
   reverse:x.reverse,cancellationMentioned:x.cancellationMentioned,cancellationState:x.cancellationState,invoiceNumbers:x.invoiceNumbers,
  }));
  const aqaba=readAqabaTransfers(text);
  const batches=buildSapBatches('lieutenantImport',items);
  if(aqaba.items.length)batches.push(...buildSapBatches('aqabaTransfer',aqaba.items));
  return {kind,issues:scan.issues,documents,batches,count:scan.transfers.length};
 }
 if(kind==='opening'||kind==='balance'){
  const stock=parseLieutenantStock(text,kind);
  return {kind,issues:stock.issues,documents:[],batches:[],count:stock.items.length};
 }
 if(kind==='monthly')return {kind,issues:[],documents:[],batches:[],count:text.trim().split(/\r?\n/).length-1};
 if(kind==='other')return {kind,issues:['أعمدة غير معروفة. حُفظ الأصل للمراجعة ولم تُنشأ بيانات أو فواتير.'],documents:[],batches:[],count:0};
 const read=kind==='official'?readAqabaOfficial(text):kind==='inventory'?readAqabaJournal(text):readAqabaTransfers(text);
 const action=kind==='official'?'aqabaOfficial':kind==='inventory'?'aqabaJournal':'aqabaTransfer';
 return {kind,issues:read.issues,documents:[],batches:buildSapBatches(action,read.items),count:read.items.length};
}
export type SapJob={key:string;kind:SapKind;count:number;total:number;done:number;failed:number;running:number;status:'complete'|'review'|'archived'|'pending'|'running'|'failed';issues:string[];documents:SapPlan['documents'];batches:{idx:number;state:string;error:string;duration:number}[];updated:string;duration:number};
