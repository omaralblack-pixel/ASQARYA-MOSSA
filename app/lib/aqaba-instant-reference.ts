import {aqabaSeedInvoiceLines} from './aqaba-blue-seed';
import {digits,sapReferences,type Item} from './reconcile';
import type {BlueLine} from './aqaba';

/** The instant-match Aqaba price scope is branch 84 ONLY, not name substrings. */
export function isAqabaBranch(branch:string):boolean {
 const name=digits(branch||'').replace(/[\u200e\u200f]/g,'').trim();
 return /^84\s*[—–-]\s*العقبة$/.test(name);
}

/** Build an SAP-code-specific reference from verified Aqaba blue prices in fils.
 * Saved price rows override the bundled 03-Nov seed, with latest invoice date
 * taking precedence. Never fall back to Amman prices or workbook-estimated packs.
 */
export function aqabaMatchReference(amman:Item[],saved:BlueLine[]):Item[]{
 const byId=new Map(aqabaSeedInvoiceLines(amman).map(row=>[row.key,row]));
 for(const row of saved){
  if(!row||typeof row.key!=='string'||!/^[A-Z]{2,6}\d{3,10}$/.test(row.item)||
     typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||
     typeof row.invoice!=='string'||!/^\d{7,20}$/.test(row.invoice)||
     typeof row.price!=='number'||!Number.isFinite(row.price)||row.price<0)
    throw Error('مرجع أسعار العقبة يحتوي بندًا غير صالح. لا يجوز استخدام أسعار عمّان بدلًا عنه.');
  byId.set(row.key,row);
 }
 const latest=new Map<string,BlueLine>();
 for(const row of byId.values()){
  const previous=latest.get(row.item);
  if(!previous||row.date>previous.date||
     (row.date===previous.date&&row.invoice>previous.invoice))
   latest.set(row.item,row);
 }
 const source=new Map<string,Item[]>();
 for(const candidate of sapReferences(amman.filter(item=>item.active))){
  const candidates=source.get(candidate.sapCode)||[];
  candidates.push(candidate);source.set(candidate.sapCode,candidates);
 }
 const agreedNumber=(items:Item[],key:'cartonPieces'|'kgPerPiece')=>{
  const values=[...new Set(items.map(item=>item[key]))];
  return values.length===1?values[0]:null;
 };
 const priced:Item[]=[...latest.values()].map(row=>{
  const price=Math.round(row.price*1000);
  if(!Number.isSafeInteger(price)||Math.abs(price/1000-row.price)>0.000001)
   throw Error('سعر عقبة غير صالح للصنف '+row.item+'؛ يجب تسجيل الأسعار حتى ثلاثة منازل عشرية.');
  const matches=source.get(row.item)||[];
  const match=matches.length===1?matches[0]:null;
  const warehouseUnit=match?.warehouseUnit||null;
  return {
   code:row.item, sapCode:row.item,
   name:row.description&&row.description!==row.item?row.description:(match?.name||row.item),
   price,active:true,
   invoicePack:null,sapUnit:match?.sapUnit||'Piece',
   warehouseUnit, warehouseName:match?.warehouseName||row.description||row.item,
   cartonPieces:agreedNumber(matches,'cartonPieces'),
   kgPerPiece:agreedNumber(matches,'kgPerPiece'),
  };
 });
 // A catalog mapping and an Aqaba price are independent. Keep confirmed SAP
 // conversions visible even before an Aqaba price is recorded, without ever
 // borrowing the institution's Amman price. Retain SAP-based keys in Aqaba.
 const unpriced:Item[]=[...source.entries()].filter(([sapCode])=>!latest.has(sapCode))
  .map(([sapCode,matches])=>{
   const match=matches.length===1?matches[0]:null;
   return {code:sapCode,sapCode,name:match?.name||sapCode,price:null,active:true,
    invoicePack:null,sapUnit:match?.sapUnit||'Piece',
    warehouseUnit:match?.warehouseUnit||null,warehouseName:match?.warehouseName||null,
    cartonPieces:agreedNumber(matches,'cartonPieces'),kgPerPiece:agreedNumber(matches,'kgPerPiece')};
  });
 return [...priced,...unpriced].sort((a,b)=>a.sapCode.localeCompare(b.sapCode));
}
