import {dateValue,digits,numeric} from './reconcile';
import {readSapImportRows} from './sap-import';

type StockRow = {
  sapCode:string; name:string; unit:string; incoming:number; reverse:number; cancellation:number; net:number;
};

export const stockHeaders = ['كود SAP','اسم الصنف في SAP','الوحدة','الوارد إلى 011','العكسي من 011','أثر الإلغاء','الصافي إلى 011'];
const units = new Map([['piece','حبة'],['carton','كرتونة'],['kg','كغم']]);
const roundQuantity = (value:number)=>Number(value.toFixed(6));

export type StockDateRange={from?:string;to?:string};

// Dates are the SAP transfer document dates (not the upload date).
// The same inclusive range applies to incoming, reverse, and cancellation lines.
export function stockReport(text:string,range:StockDateRange={}) {
  const {rows,issues}=readSapImportRows(text);
  const byCodeAndUnit=new Map<string,StockRow>();
  const dates=new Set<string>();
  const allDocuments=new Set<string>();
  const allCodes=new Set<string>();
  const documents=new Set<string>();
  for(const [document,dateText,,,,rawCode,name,rawQuantity,rawUnit,from,to] of rows){
    if(!from||!to){
      issues.push('الترحيل '+document+'، الصنف '+(rawCode||'—')+' — بيانات المستودعات ناقصة.');
      continue;
    }
    const source=digits(from).padStart(3,'0');
    const destination=digits(to).padStart(3,'0');
    if((source!=='011'&&destination!=='011')||source===destination)continue;
    const date=dateValue(dateText);
    const sapCode=rawCode.toUpperCase();
    const canceled=/^[-−]/.test(rawQuantity);
    const quantity=numeric(canceled?rawQuantity.slice(1):rawQuantity);
    if(!date||!sapCode||!rawUnit||quantity===null){
      // A damaged row outside a selected period cannot change its subtotal,
      // but missing/invalid dates must still be disclosed (period unknown).
      if(!date||(!range.from||date>=range.from)&&(!range.to||date<=range.to))
        issues.push('الترحيل '+document+'، الصنف '+(sapCode||'—')+' — راجع التاريخ والكود والكمية والوحدة.');
      continue;
    }
    dates.add(date);
    allDocuments.add(document);
    allCodes.add(sapCode);
    if((range.from&&date<range.from)||(range.to&&date>range.to))continue;

    const unit=units.get(rawUnit.toLowerCase())??rawUnit;
    const key=JSON.stringify([sapCode,unit]);
    const row=byCodeAndUnit.get(key)??{sapCode,name,unit,incoming:0,reverse:0,cancellation:0,net:0};
    if(!row.name)row.name=name;
    if(canceled)row.cancellation+=destination==='011'?-quantity:quantity;
    else if(destination==='011')row.incoming+=quantity;
    else row.reverse+=quantity;
    byCodeAndUnit.set(key,row);
    documents.add(document);
  }
  const items=[...byCodeAndUnit.values()].sort((a,b)=>a.sapCode.localeCompare(b.sapCode)||a.unit.localeCompare(b.unit,'ar'));
  for(const row of items){
    row.net=roundQuantity(row.incoming-row.reverse+row.cancellation);
    row.incoming=roundQuantity(row.incoming);
    row.reverse=roundQuantity(row.reverse);
    row.cancellation=roundQuantity(row.cancellation);
  }
  const period=[...dates].sort();
  return {items,issues,from:period[0],to:period.at(-1),
    documents:documents.size,codes:new Set(items.map(row=>row.sapCode)).size,
    allDocuments:allDocuments.size,allCodes:allCodes.size};
}
