import {dateValue,digits,numeric,parseTransfer,type Draft,type Transfer} from './reconcile';

const headers=['رقم الترحيل','تاريخ الترحيل','كود الفرع','اسم الفرع','Remarks','Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'];
const normalize=(value:string)=>value.trim().toLowerCase();
const transferHeader=headers.slice(5).join('\t');

type SapTransfer={
  transfer:Transfer;
  branch:string;
  branchLabel:string;
  remarks:string;
  invoices:string[];
  lineCount:number;
  reversal:boolean;
  issues:string[];
};

export type SapImportGroup={draft:Draft; members:SapTransfer[]; issues:string[]; reversal:boolean};

function readInvoices(remarks:string){
  const prefix=digits(remarks).split(/based on inventory transfer request/i)[0].split('||')[0].trim();
  if(!/^\d+(?:[\s,،;؛/+&-]+\d+)*$/.test(prefix))return [];
  return [...new Set((prefix.match(/\d+/g)||[]).filter(number=>/^\d{10}$/.test(number)))];
}

export function parseSapImport(paste:string,branches:string[]):{groups:SapImportGroup[]; issues:string[]}{
  const rows=paste.replace(/^\uFEFF/,'').split(/\r?\n/);
  const headerIndex=rows.findIndex(line=>line.trim());
  const columns=(rows[headerIndex]||'').split('\t').map(normalize);
  const indexes=headers.map(header=>columns.indexOf(normalize(header)));
  const missing=headers.filter((_,i)=>indexes[i]<0);
  if(missing.length)return {groups:[],issues:['أعمدة مفقودة: '+missing.join('، ')]};

  const branchesByCode=new Map(branches.map(branch=>[branch.split(' — ')[0].trim(),branch]));
  const branchesByName=new Map(branches.map(branch=>[branch.split(' — ').slice(1).join(' — ').trim(),branch]));
  const transfers=new Map<string,{meta:string[]; lines:string[]; reversal:boolean; conflict:boolean}>();
  const issues:string[]=[];
  for(let i=headerIndex+1;i<rows.length;i++){
    if(!rows[i].trim())continue;
    const cells=rows[i].split('\t');
    const values=indexes.map(index=>(cells[index]||'').trim());
    if(normalize(values[0])===normalize(headers[0]))continue;
    const number=digits(values[0]);
    if(!/^\d+$/.test(number)){
      issues.push('السطر '+(i+1)+' بلا رقم ترحيل صالح');
      continue;
    }
    const meta=values.slice(1,5);
    const existing=transfers.get(number);
    const entry=existing||{meta,lines:[],reversal:false,conflict:false};
    if(existing&&meta.some((value,index)=>value!==entry.meta[index]))entry.conflict=true;
    entry.lines.push(values.slice(5).join('\t'));
    entry.reversal||=/has been canceled/i.test(values[4])||(numeric(values[7])??0)<0;
    transfers.set(number,entry);
  }

  const groups:SapImportGroup[]=[];
  const invoiceGroups=new Map<string,SapTransfer[]>();
  const memberGroups=new Set<SapTransfer[]>();
  for(const [number,entry] of transfers){
    const [dateText,branchCode,branchName,remarks]=entry.meta;
    const date=dateValue(dateText.replace(/\./g,'/'))||'';
    const branch=branchesByCode.get(digits(branchCode))||(!branchCode&&branchName?branchesByName.get(branchName):'')||'';
    const transfer={id:'sap-'+number,number,date,paste:[transferHeader,...entry.lines].join('\n')};
    const parsed=parseTransfer(transfer.paste);
    const itemIssues:string[]=[];
    if(entry.conflict)itemIssues.push('بيانات الترحيل تختلف بين سطوره');
    if(!date)itemIssues.push('تاريخ الترحيل غير صالح');
    if(!branch)itemIssues.push('الفرع غير معروف');
    if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length)itemIssues.push('راجع بنود الترحيل أو وحداته أو مستودعاته');
    const member={transfer,branch,branchLabel:branchName||branchCode,remarks,invoices:entry.reversal?[]:readInvoices(remarks),lineCount:entry.lines.length,reversal:entry.reversal,issues:itemIssues};
    const keys=branch&&!entry.reversal&&!entry.conflict?member.invoices.map(invoice=>branch+'|'+invoice):[];
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
    const notes=members.map(item=>item.transfer.number+' — '+item.remarks).join('\n');
    if(members.length>30||invoiceNumbers.length>30||notes.length>5000)groupIssues.push('المجموعة أكبر من حد الحفظ؛ قسّمها يدويًا');
    const draft:Draft={
      mode:'manual',checks:{},branch:members[0].branch,driver:'',date,
      transfers:members.map(item=>item.transfer),
      invoices:(invoiceNumbers.length?invoiceNumbers:['']).map((number,index)=>({
        id:'invoice-'+(index+1),number,date:'',amount:'',complete:false,quantities:{},attachments:[],
      })),
      notes,
    };
    groups.push({draft,members,issues:groupIssues,reversal:members[0].reversal});
  }
  if(!groups.length&&!issues.length)issues.push('لا توجد سطور ترحيلات في الجدول');
  return {groups,issues};
}
