import {parseLieutenantTransfers} from './lieutenant';
import {listSapFiles,readSapArchive} from './sap-files-client';
import {dateValue,digits,parseTransfer,withInvoiceDates,type Draft,type Transfer} from './reconcile';
import {sapBranchFromRemarks,type SapImportGroup} from './sap-import';

export type SapEvidence={
 transfer:Transfer;branch:string;remarks:string;invoiceNumbers:string[];
 reverse:boolean;cancellationState:string;sourceFile:string;issues?:string[];
};

export function matchesSapEvidence(item:SapEvidence,number:string,kind:'invoice'|'transfer'){
 const searched=digits(number).trim();
 return kind==='transfer'?item.transfer.number===searched:item.invoiceNumbers.includes(searched);
}

/** Construct a temporary, unsaved invoice proposal from verifiable SAP evidence. */
export function groupSapEvidence(items:SapEvidence[],number:string,kind:'invoice'|'transfer',officialBranches:string[]=[]):SapImportGroup|null{
 const chosen=[...new Map(items.filter(item=>matchesSapEvidence(item,number,kind))
   .map(item=>[item.transfer.number,item] as const)).values()].map(item=>({
     ...item,branch:item.branch||sapBranchFromRemarks(item.remarks,officialBranches)
   }));
 if(!chosen.length)return null;
 const branches=new Set(chosen.map(item=>item.branch).filter(Boolean));
 const invoiceNumbers=[...new Set(chosen.flatMap(item=>item.invoiceNumbers))];
 const issues:string[]=[];
 if(branches.size>1)issues.push('الفاتورة مرتبطة بترحيلات من فروع مختلفة؛ يلزم مراجعة الربط.');
 if(chosen.some(item=>!item.branch))issues.push('الفرع غير معروف في أحد ترحيلات SAP.');
 if(chosen.length>30||invoiceNumbers.length>30)issues.push('عدد المستندات يتجاوز الحد المسموح؛ راجع المطابقة التفصيلية.');
 const members:SapImportGroup['members']=chosen.map(item=>{
   const parsed=parseTransfer(item.transfer.paste,{allowReverse:true});
   const reversed=item.reverse||parsed.lines.some(line=>line.from==='011');
   const canceled=['canceled','cancellation'].includes(item.cancellationState);
   const memberIssues=[...(item.issues||[]),...parsed.issues];
   if(parsed.excluded.length||!parsed.lines.length)memberIssues.push('بعض بنود الترحيل غير صالحة أو خارج 011.');
   if(!dateValue(item.transfer.date))memberIssues.push('تاريخ ترحيل SAP غير صالح.');
   return {transfer:item.transfer,branch:item.branch,branchLabel:item.branch,remarks:item.remarks,
     invoices:item.invoiceNumbers,lineCount:parsed.lines.length,
     reversal:reversed||canceled,reverseMovement:reversed,issues:memberIssues};
 });
 const branch=branches.size===1?[...branches][0]:'';
 const date=dateValue(chosen[0].transfer.date)||'';
 const invoiceList=invoiceNumbers.length?invoiceNumbers:[''];
 const draft:Draft={mode:'manual',checks:{},branch,driver:'',date,notes:'',
   transfers:chosen.map(item=>item.transfer),
   invoices:invoiceList.map((invoice,index)=>({id:'sap-evidence-'+index,number:invoice,date:'',
     dateTransferNos:chosen.filter(item=>item.invoiceNumbers.includes(invoice)).map(item=>item.transfer.number),
     amount:'',complete:false,quantities:{},attachments:[]}))};
 return {draft:withInvoiceDates(draft),members,issues,reversal:members.some(item=>item.reversal)};
}

/** Search immutable SAP originals, not only current.json. Newest version per
 * transfer wins; old files never silently overwrite a newer SAP document.
 * This runs only after an operator clicks search, not on each keystroke.
 */
export async function searchArchivedSapEvidence(number:string,kind:'invoice'|'transfer',branches:string[]){
 const files=(await listSapFiles()).filter(file=>file.kind==='transfers')
   .sort((a,b)=>b.created.localeCompare(a.created)||b.key.localeCompare(a.key));
 const byTransfer=new Map<string,SapEvidence>();
 let unreadable=0;
 for(const file of files){
   try{
     const source=await readSapArchive(file);
     const scan=parseLieutenantTransfers(source,branches);
     if(!scan.transfers.length&&scan.issues.length){unreadable++;continue}
     for(const row of scan.transfers){
       const key=row.transfer.number;
       if(!byTransfer.has(key))byTransfer.set(key,{
         transfer:row.transfer,branch:row.branch,remarks:row.remarks,
         invoiceNumbers:row.invoiceNumbers,reverse:row.reverse,
         cancellationState:row.cancellationState,sourceFile:file.key,issues:row.issues
       });
     }
   }catch{unreadable++}
 }
 return {hits:[...byTransfer.values()].filter(item=>matchesSapEvidence(item,number,kind)),
   unreadable,scanned:files.length};
}
