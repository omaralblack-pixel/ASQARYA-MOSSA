import {dateValue,digits,invoiceDocumentNo,numeric,parseTransfer,withInvoiceDates,type Draft,type Transfer} from './reconcile';

const headers=['رقم الترحيل','تاريخ الترحيل','كود الفرع','اسم الفرع','Remarks','Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'];
const normalize=(value:string)=>value.trim().toLowerCase();
const branchCodeKey=(value:string)=>digits(value).trim().replace(/^0+(?=\d)/,'');
const branchNameKey=(value:string)=>normalize(value).replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي')
  .replace(/[\u064B-\u065F\u0670ـ]/g,'').replace(/\s+/g,' ');
const transferHeader=headers.slice(5).join('\t');

type SapTransfer={
  transfer:Transfer;
  branch:string;
  branchLabel:string;
  remarks:string;
  invoices:string[];
  lineCount:number;
  reversal:boolean;
  reverseMovement:boolean;
  canceledTransferNo?:string;
  issues:string[];
};

export type SapImportGroup={draft:Draft; members:SapTransfer[]; issues:string[]; reversal:boolean};

// A selected institution branch can resolve a missing SAP branch only when
// every other SAP validation succeeded. Never bypass canceled/reverse records.
export function canUseSelectedBranchForSapMember(member:SapTransfer,selectedBranch:string):boolean{
  return !!selectedBranch && !member.branch && !member.reversal && !member.reverseMovement &&
    member.issues.length===1 && member.issues[0]==='الفرع غير معروف';
}

function readInvoices(remarks:string){
  const prefix=digits(remarks).split(/based on inventory transfer request/i)[0].split('||')[0].trim();
  if(!/^\d+(?:[\s,،;؛/+&-]+\d+)*$/.test(prefix))return [];
  return [...new Set((prefix.match(/\d+/g)||[]).filter(number=>/^\d{10}$/.test(number)&&invoiceDocumentNo(number)))];
}

export function readSapImportRows(paste:string):{rows:string[][];issues:string[]}{
  const rows=paste.replace(/^\uFEFF/,'').split(/\r?\n/);
  const headerIndex=rows.findIndex(line=>line.trim());
  const columns=(rows[headerIndex]||'').split('\t').map(normalize);
  const indexes=headers.map(header=>columns.indexOf(normalize(header)));
  const missing=headers.filter((_,i)=>indexes[i]<0);
  if(missing.length)return {rows:[],issues:['أعمدة مفقودة: '+missing.join('، ')]};
  const data:string[][]=[];
  const issues:string[]=[];
  for(let i=headerIndex+1;i<rows.length;i++){
    if(!rows[i].trim())continue;
    const cells=rows[i].split('\t');
    const values=indexes.map(index=>(cells[index]||'').trim());
    if(normalize(values[0])===normalize(headers[0]))continue;
    values[0]=digits(values[0]);
    if(!/^\d+$/.test(values[0])){
      issues.push('السطر '+(i+1)+' بلا رقم ترحيل صالح');
      continue;
    }
    data.push(values);
  }
  return {rows:data,issues};
}

export function parseSapImport(paste:string,branches:string[]):{groups:SapImportGroup[]; issues:string[]}{
  const {rows,issues}=readSapImportRows(paste);
  const branchesByCode=new Map(branches.map(branch=>[branchCodeKey(branch.split(' — ')[0]),branch]));
  const branchesByName=new Map(branches.map(branch=>[branchNameKey(branch.split(' — ').slice(1).join(' — ')),branch]));
  const resolveBranch=(code:string,name:string)=>
    branchesByCode.get(branchCodeKey(code))||branchesByName.get(branchNameKey(name))||'';
  const transfers=new Map<string,{meta:string[]; lines:string[]; reversal:boolean; conflict:boolean}>();
  for(const values of rows){
    const number=values[0];
    const meta=values.slice(1,5);
    const existing=transfers.get(number);
    const entry=existing||{meta,lines:[],reversal:false,conflict:false};
    if(existing&&meta.some((value,index)=>value!==entry.meta[index]))entry.conflict=true;
    entry.lines.push(values.slice(5).join('\t'));
    entry.reversal||=/has been canceled/i.test(values[4])||(numeric(values[7])??0)<0;
    transfers.set(number,entry);
  }

  // If SAP omitted a branch on one transfer, use a known branch from another
  // transfer carrying the same invoice number only when the inference is unique.
  const invoiceBranches=new Map<string,Set<string>>();
  for(const entry of transfers.values()){
    if(entry.reversal||entry.conflict)continue;
    const [,code,name,remarks]=entry.meta;
    const known=resolveBranch(code,name);
    if(!known)continue;
    for(const invoice of readInvoices(remarks)){
      const owners=invoiceBranches.get(invoice)||new Set<string>();
      owners.add(known);
      invoiceBranches.set(invoice,owners);
    }
  }
  const groups:SapImportGroup[]=[];
  const invoiceGroups=new Map<string,SapTransfer[]>();
  const memberGroups=new Set<SapTransfer[]>();
  for(const [number,entry] of transfers){
    const [dateText,branchCode,branchName,remarks]=entry.meta;
    const date=dateValue(dateText.replace(/\./g,'/'))||'';
    const associatedInvoices=readInvoices(remarks);
    const knownBranches=new Set(associatedInvoices.flatMap(invoice=>[...(invoiceBranches.get(invoice)||[])]));
    const inferred=associatedInvoices.length>0&&knownBranches.size===1?[...knownBranches][0]:'';
    const branch=resolveBranch(branchCode,branchName)||inferred;
    const transfer={id:'sap-'+number,number,date,paste:[transferHeader,...entry.lines].join('\n')};
    const parsed=parseTransfer(transfer.paste,{allowReverse:true});
    const reverseMovement=parsed.lines.some(line=>line.from==='011');
    const itemIssues:string[]=[];
    if(entry.conflict)itemIssues.push('بيانات الترحيل تختلف بين سطوره');
    if(!date)itemIssues.push('تاريخ الترحيل غير صالح');
    if(!branch&&!reverseMovement)itemIssues.push('الفرع غير معروف');
    if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length)itemIssues.push('راجع بنود الترحيل أو وحداته أو مستودعاته');
    const canceledTransferNo=digits(remarks).match(/\binventory transfer no\.?\s*(\d+)\s+has been canceled\b/i)?.[1];
    const member={transfer,reverseMovement,canceledTransferNo,branch,branchLabel:branchName||branchCode,remarks,invoices:entry.reversal?[]:associatedInvoices,lineCount:entry.lines.length,reversal:entry.reversal,issues:itemIssues};
    const keys=branch&&!entry.reversal&&!entry.conflict&&!reverseMovement?member.invoices.map(invoice=>branch+'|'+invoice):[];
    const connected=[...new Set(keys.flatMap(key=>invoiceGroups.has(key)?[invoiceGroups.get(key)!]:[]))];
    const members=connected[0]||[];
    for(const other of connected.slice(1)){
      members.push(...other);
      memberGroups.delete(other);
    }
    members.push(member);
    memberGroups.add(members);
    for(const item of connected.length>1?members:[member]){
      for(const invoice of item.invoices)if(keys.length)invoiceGroups.set(branch+'|'+invoice,members);
    }
  }

  for(const members of memberGroups){
    const invoiceNumbers=[...new Set(members.flatMap(item=>item.invoices))];
    const date=members[0].transfer.date;
    const groupIssues=[...new Set(members.flatMap(item=>item.issues))];
    if(members.some(item=>item.reverseMovement))groupIssues.push('ترحيل عكسي — اربطه بمجموعة الفواتير بإدخال رقمه');
    const notes=members.map(item=>item.transfer.number+' — '+item.remarks).join('\n');
    if(members.length>30||invoiceNumbers.length>30||notes.length>5000)groupIssues.push('المجموعة أكبر من حد الحفظ؛ قسّمها يدويًا');
    const draft:Draft={
      mode:'manual',checks:{},branch:members[0].branch,driver:'',date,
      transfers:members.map(item=>item.transfer),
      invoices:(invoiceNumbers.length?invoiceNumbers:['']).map((number,index)=>({
        id:'invoice-'+(index+1),number,date:'',dateTransferNos:members.filter(item=>item.invoices.includes(number)).map(item=>item.transfer.number),amount:'',complete:false,quantities:{},attachments:[],
      })),
      notes,
    };
    groups.push({draft:withInvoiceDates(draft),members,issues:groupIssues,reversal:members[0].reversal});
  }
  if(!groups.length&&!issues.length)issues.push('لا توجد سطور ترحيلات في الجدول');
  return {groups,issues};
}
