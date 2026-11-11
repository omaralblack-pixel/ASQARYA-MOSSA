import {dateValue,digits,numeric,type Transfer} from './reconcile';

/** Read every SAP transfer touching warehouse 011, regardless of counterparty.
 * Supports both the original SAP export and the Arabic aliases in the 011 query.
 * Missing cancellation status stays unknown; Remarks alone is not proof.
 */
export type CancellationState='active'|'canceled'|'cancellation'|'unknown';
export type LieutenantTransfer={
  transfer:Transfer;
  branch:string;
  remarks:string;
  lineCount:number;
  reverse:boolean;
  cancellationState:CancellationState;
  cancellationMentioned:boolean;
  issues:string[];
  invoiceNumbers:string[];
};
export type LieutenantScan={transfers:LieutenantTransfer[];issues:string[]};
const header=(x:string)=>x.toLowerCase().replace(/[\s._\-:،]+/g,'').trim();
const aliases={
  number:['رقم الترحيل','Document Number','DocNum','Doc No','Transfer Number'],
  date:['تاريخ الترحيل','التاريخ','DocDate','Document Date','Posting Date'],
  branchCode:['كود الفرع','Branch Code','BranchCode'],
  branchName:['اسم الفرع','الفرع','Branch Name','Branch'],
  remarks:['Remarks','Comments','Journal Remarks','ملاحظات','الملاحظات'],
  code:['Item No.','ItemCode','Item No','كود الصنف','رقم الصنف','رقم المادة'],
  name:['Item Description','ItemName','اسم الصنف','وصف الصنف'],
  quantity:['Quantity','الكمية'],
  unit:['UoM Code','UoM Name','UoM','الوحدة','وحدة المخزون'],
  from:['From Warehouse','FromWhsCod','من مستودع','من المستودع'],
  to:['To Warehouse','WhsCode','إلى مستودع','الى مستودع','إلى المستودع'],
  canceled:['CANCELED','حالة الإلغاء'],
} as const;
type Field=keyof typeof aliases;
const required:Field[]=['number','date','code','quantity','unit','from','to'];
const headIndex=(headers:string[],field:Field)=>
  headers.findIndex(value=>aliases[field].some(alias=>header(alias)===value));
const wh=(x:string)=>{
  const value=digits(x||'').trim();
  return /^\d+$/.test(value)?value.padStart(3,'0'):value;
};
const unit=(x:string)=>{
  const value=x.trim().toLowerCase();
  return value==='piece'||value==='pieces'?'Piece':value==='carton'||value==='cartons'?'Carton':value==='kg'?'KG':null;
};
const postingDate=(raw:string):string=>{
  const formatted=dateValue(raw.replace(/\\./g,'/'));
  if(formatted)return formatted;
  // Excel can store SAP posting dates as numeric serial values, not formatted strings.
  if(!/^\\d{5}(?:\\.\\d+)?$/.test(raw))return '';
  const serial=Math.floor(Number(raw));
  if(serial<30000||serial>80000)return '';
  return new Date(Date.UTC(1899,11,30)+serial*86400000).toISOString().slice(0,10);
};
const cancellation=(raw:string):CancellationState=>{
  const value=raw.trim().toUpperCase();
  if(value==='N'||value==='NO'||value==='غير ملغى')return 'active';
  if(value==='Y'||value==='YES'||value==='ملغى')return 'canceled';
  if(value==='C'||value==='CANCELLATION')return 'cancellation';
  return 'unknown';
};
const invoices=(remarks:string)=>[...new Set(remarks.match(/\b\d{10}\b/g)||[])];
type Group={meta:{date:string;branchCode:string;branchName:string;remarks:string;state:CancellationState};lines:string[];issues:string[];reverse:boolean};
const lineHeader=['Item No.','Item Description','Quantity','UoM Code','From Warehouse','To Warehouse'].join('\t');

export function parseLieutenantTransfers(source:string,branches:string[]):LieutenantScan{
  const raw=source.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n');
  const first=raw.findIndex(line=>line.trim());
  const columns=(raw[first]||'').split('\t').map(header);
  const indexes=Object.fromEntries(Object.keys(aliases).map(key=>[key,headIndex(columns,key as Field)])) as Record<Field,number>;
  const missing=required.filter(field=>indexes[field]<0);
  if(missing.length)return {transfers:[],issues:['أعمدة SAP مفقودة: '+missing.map(x=>aliases[x][0]).join('، ')]};
  const read=(cells:string[],field:Field)=>indexes[field]<0?'':(cells[indexes[field]]||'').trim();
  const byCode=new Map(branches.map(item=>[digits(item.split(' — ')[0].trim()),item]));
  const byName=new Map(branches.map(item=>[item.split(' — ').slice(1).join(' — ').trim(),item]));
  const grouped=new Map<string,Group>();
  const issues:string[]=[];
  for(let i=first+1;i<raw.length;i++){
    if(!raw[i].trim())continue;
    const cells=raw[i].split('\t');
    if(aliases.number.some(alias=>header(read(cells,'number'))===header(alias)))continue;
    const number=digits(read(cells,'number'));
    if(!/^\d{4,20}$/.test(number)){
      issues.push('السطر '+(i+1)+' بلا رقم ترحيل صالح.');
      continue;
    }
    const from=wh(read(cells,'from')),to=wh(read(cells,'to'));
    if(from!=='011'&&to!=='011')continue;
    const rawDate=read(cells,'date');
    const meta={
      date:postingDate(rawDate),
      branchCode:read(cells,'branchCode'),branchName:read(cells,'branchName'),
      remarks:read(cells,'remarks'),state:cancellation(read(cells,'canceled')),
    };
    const current=grouped.get(number)||{meta,lines:[],issues:[],reverse:false};
    if(grouped.has(number)&&
      (meta.date!==current.meta.date||
       (meta.state!==current.meta.state&&meta.state!=='unknown'&&current.meta.state!=='unknown')))
      current.issues.push('معلومات الترحيل أو حالة الإلغاء تختلف بين سطوره.');
    if(!current.meta.remarks&&meta.remarks)current.meta.remarks=meta.remarks;
    if(current.meta.state==='unknown'&&meta.state!=='unknown')current.meta.state=meta.state;
    const code=read(cells,'code').toUpperCase();
    const description=read(cells,'name');
    const qty=numeric(read(cells,'quantity'));
    const u=unit(read(cells,'unit'));
    if(from===to)current.issues.push('حركة 011 إلى 011 غير صالحة.');
    if(!/^[A-Z]{2,6}\d{3,10}$/.test(code))current.issues.push('كود SAP غير صالح: '+code);
    if(qty===null||qty<0||qty>100000000)current.issues.push('كمية غير صالحة للصنف '+code);
    if(!u)current.issues.push('وحدة SAP غير معروفة للصنف '+code+': '+read(cells,'unit'));
    current.reverse ||= from==='011';
    current.lines.push([code,description,read(cells,'quantity'),u||read(cells,'unit'),from,to].join('\t'));
    grouped.set(number,current);
  }
  const transfers:LieutenantTransfer[]=[];
  for(const [number,group] of grouped){
    const {date,branchCode,branchName,remarks,state}=group.meta;
    const problems=[...new Set(group.issues)];
    if(!date)problems.push('تاريخ الترحيل غير صالح.');
    transfers.push({
      transfer:{id:'lieutenant-'+number,number,date,paste:[lineHeader,...group.lines].join('\n')},
      branch:byCode.get(digits(branchCode))||byName.get(branchName)||'',
      remarks,lineCount:group.lines.length,reverse:group.reverse,
      cancellationState:state,
      cancellationMentioned:/has been canceled|cancelled|ملغى|إلغاء/i.test(remarks),
      issues:problems,invoiceNumbers:invoices(remarks),
    });
  }
  if(!transfers.length&&!issues.length)issues.push('لا توجد ترحيلات للمستودع 011.');
  return {transfers,issues};
}
