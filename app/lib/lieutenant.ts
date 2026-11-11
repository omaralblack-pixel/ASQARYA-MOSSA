import {dateValue,digits,numeric,type Transfer} from './reconcile';
import {readSapImportRows} from './sap-import';

/** All movements touching 011. Unlike the invoice importer, this supervisor
 * intentionally includes any counterparty warehouse and does not discard reversals.
 */
export type LieutenantTransfer = {
  transfer: Transfer;
  branch: string;
  remarks: string;
  lineCount: number;
  reverse: boolean;
  canceled: boolean;
  cancellationMentioned: boolean;
  issues: string[];
  invoiceNumbers: string[];
};
export type LieutenantScan = {transfers:LieutenantTransfer[];issues:string[]};

const lineHeader = ['Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'].join('\t');
const wh=(value:string)=>{
  const trimmed=digits(value||'').trim();
  return /^\d+$/.test(trimmed)?trimmed.padStart(3,'0'):trimmed;
};
const codePattern=/^[A-Z]{2,6}\d{3,10}$/;
const units=new Set(['piece','carton','kg']);
const invoiceNumbers=(remarks:string)=>
  [...new Set((remarks.match(/\b\d{10}\b/g)||[]))];

export function parseLieutenantTransfers(source:string,branches:string[]):LieutenantScan{
  const {rows,issues}=readSapImportRows(source);
  const byCode=new Map(branches.map(item=>[digits(item.split(' — ')[0].trim()),item]));
  const byName=new Map(branches.map(item=>[item.split(' — ').slice(1).join(' — ').trim(),item]));
  const grouped=new Map<string,{meta:string[];lines:string[];issues:string[];reverse:boolean}>();
  for(const values of rows){
    const [number,rawDate,branchCode,branchName,remarks,sapCode,description,quantity,unit,rawFrom,rawTo]=values;
    const from=wh(rawFrom),to=wh(rawTo);
    if(from!=='011'&&to!=='011')continue;
    const current=grouped.get(number)||{meta:[rawDate,branchCode,branchName,remarks],lines:[],issues:[],reverse:false};
    if(grouped.has(number)&&[rawDate,branchCode,branchName,remarks]
      .some((value,i)=>value!==current.meta[i]))
      current.issues.push('بيانات الترحيل تختلف بين سطوره.');
    const code=sapCode.toUpperCase(),qty=numeric(quantity);
    if(from===to)current.issues.push('حركة المستودع 011 إلى نفسه غير صالحة.');
    if(!codePattern.test(code))current.issues.push('كود SAP غير صالح: '+sapCode);
    if(qty===null||qty<0)current.issues.push('كمية غير صالحة للصنف '+code);
    if(!units.has(unit.toLowerCase()))current.issues.push('وحدة SAP غير معروفة للصنف '+code+': '+unit);
    current.reverse||=from==='011';
    current.lines.push([code,description,quantity,unit,from,to].join('\t'));
    grouped.set(number,current);
  }
  const transfers:LieutenantTransfer[]=[];
  for(const [number,value] of grouped){
    const [rawDate,branchCode,branchName,remarks]=value.meta;
    const date=dateValue(rawDate.replace(/\./g,'/'))||'';
    const problems=[...new Set(value.issues)];
    if(!date)problems.push('تاريخ الترحيل غير صالح.');
    // A remark saying canceled is a clue, NOT proof of SAP's cancellation status.
    const cancellationMentioned=/has been canceled|cancelled|ملغى|إلغاء/i.test(remarks);
    const branch=byCode.get(digits(branchCode))||byName.get(branchName)||'';
    transfers.push({
      transfer:{id:'lieutenant-'+number,number,date,paste:[lineHeader,...value.lines].join('\n')},
      branch,remarks,lineCount:value.lines.length,reverse:value.reverse,canceled:false,
      cancellationMentioned,issues:problems,invoiceNumbers:invoiceNumbers(remarks),
    });
  }
  if(!transfers.length&&!issues.length)issues.push('لا توجد ترحيلات للمستودع 011.');
  return {transfers,issues};
}
