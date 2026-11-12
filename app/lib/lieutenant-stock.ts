import type {LieutenantTransfer} from './lieutenant';

export type LieutenantFileKind='transfers'|'opening'|'balance'|'other';
export type StockItem={code:string;name:string;warehouse:string;unit:string;quantity:number};
export type StockRead={items:StockItem[];issues:string[]};
export type StockAuditItem=StockItem&{
  opening:number|null;incoming:number;outgoing:number;netTransfers:number;
  approvedIncoming:number;estimated:number|null;difference:number|null;
};
const clean=(value:string)=>value.replace(/^\uFEFF/,'').toLowerCase()
  .replace(/[\s._\-:،#]+/g,'').trim();
const fields={
  code:['رقم الصنف','كود الصنف','item no.','item no','itemcode'],
  name:['اسم الصنف','وصف الصنف','item description','itemname'],
  warehouse:['المستودع','warehouse','whs'],
  unit:['وحدة المخزون','الوحدة','inventory uom','invntryuom','uom code','uom'],
  balance:['الرصيد الفعلي بنهاية التاريخ','الرصيد الفعلي','closing balance','closing stock','quantity on hand'],
  opening:['الرصيد الافتتاحي','رصيد افتتاحي','opening balance','opening stock'],
  doc:['رقم الترحيل','document number','docnum','doc no','transfer number'],
  date:['تاريخ الترحيل','التاريخ','document date','docdate','posting date'],
  from:['من مستودع','من المستودع','from warehouse','fromwhscod'],
  to:['إلى مستودع','الى مستودع','إلى المستودع','to warehouse','whscode'],
  quantity:['الكمية','quantity'],
} as const;
type Column=keyof typeof fields;
const index=(header:string[],field:Column)=>header.findIndex(col=>fields[field].some(alias=>col===clean(alias)));
const firstHeader=(source:string)=>source.replace(/^\uFEFF/,'').replace(/\r/g,'')
  .split('\n').find(row=>row.trim())?.split('\t').map(clean)||[];

export function classifyLieutenantContent(source:string):LieutenantFileKind{
  const header=firstHeader(source);
  if(['doc','date','from','to','code','quantity'].every(field=>index(header,field as Column)>=0))return 'transfers';
  if(['code','warehouse','unit'].every(field=>index(header,field as Column)>=0)){
    if(index(header,'balance')>=0)return 'balance';
    if(index(header,'opening')>=0)return 'opening';
  }
  return 'other';
}

const normalizeUnit=(raw:string)=>{
  const value=raw.trim().toLowerCase();
  if(['piece','pieces','حبة','حبات'].includes(value))return 'Piece';
  if(['carton','cartons','كرتونة','كرتون'].includes(value))return 'Carton';
  if(['kg','كغم','كيلو'].includes(value))return 'KG';
  if(['bag','bags','كيس'].includes(value))return 'Bag';
  return raw.trim();
};
const normalizeWarehouse=(raw:string)=>/^\d+$/.test(raw.trim())?raw.trim().padStart(3,'0'):raw.trim();
const number=(raw:string)=>{
  const value=raw.trim().replace(/,/g,'');
  return /^[+-]?\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
};
const round=(value:number)=>Number(value.toFixed(6));

export function parseLieutenantStock(source:string,kind:'opening'|'balance'):StockRead{
  const lines=source.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n');
  const first=lines.findIndex(line=>line.trim());
  const headers=(lines[first]||'').split('\t').map(clean);
  const columns=['code','warehouse','unit',kind] as const;
  const missing=columns.filter(field=>index(headers,field)<0);
  if(missing.length)return {items:[],issues:['كشف الرصيد لا يحتوي الأعمدة المطلوبة: '+missing.join('، ')]};
  const at=(row:string[],field:Column)=>row[index(headers,field)]?.trim()||'';
  const items:StockItem[]=[];
  const seen=new Set<string>();
  const issues:string[]=[];
  for(let i=first+1;i<lines.length;i++){
    if(!lines[i].trim())continue;
    const row=lines[i].split('\t');
    if(clean(at(row,'code'))===clean('رقم الصنف'))continue;
    const code=at(row,'code').toUpperCase();
    const warehouse=normalizeWarehouse(at(row,'warehouse'));
    const unit=normalizeUnit(at(row,'unit'));
    const quantity=number(at(row,kind));
    if(warehouse!=='011')continue;
    if(!/^[A-Z]{2,6}\d{3,10}$/.test(code)||!unit||!Number.isFinite(quantity)){
      issues.push('السطر '+(i+1)+': رقم الصنف أو الوحدة أو الرصيد غير صالح.');
      continue;
    }
    const key=code+'|'+unit;
    if(seen.has(key)){
      issues.push('السطر '+(i+1)+': الصنف '+code+' مكرر بنفس الوحدة؛ لم يُجمع مرتين.');
      continue;
    }
    seen.add(key);
    items.push({code,name:at(row,'name'),warehouse,unit,quantity});
  }
  if(!items.length)issues.push('لا يحتوي الملف على أرصدة صالحة للمستودع 011.');
  return {items,issues};
}

/** The estimate only uses transfers and is NOT the complete OINM inventory journal.
 * Never infer a zero opening balance or convert between SAP UoMs implicitly.
 */
export function auditLieutenantStock(
  closing:StockItem[],opening:StockItem[],transfers:LieutenantTransfer[],
  approvedTransferNumbers:ReadonlySet<string>,from:string,to:string,
):StockAuditItem[]{
  const starts=new Map(opening.filter(row=>row.warehouse==='011').map(row=>[row.code+'|'+row.unit,row.quantity]));
  const movement=new Map<string,{incoming:number;outgoing:number;approvedIncoming:number}>();
  for(const source of transfers){
    if(source.issues.length||source.transfer.date<from||source.transfer.date>to||
      source.cancellationState==='canceled'||source.cancellationState==='cancellation')continue;
    for(const line of source.transfer.paste.split('\n').slice(1)){
      const [code,,rawQty,rawUnit,rawFrom,rawTo]=line.split('\t');
      const qty=number(rawQty||'');
      const unit=normalizeUnit(rawUnit||'');
      const fromWh=normalizeWarehouse(rawFrom||''),toWh=normalizeWarehouse(rawTo||'');
      if(!code||!unit||!Number.isFinite(qty)||qty<0)continue;
      const key=code.toUpperCase()+'|'+unit;
      const item=movement.get(key)||{incoming:0,outgoing:0,approvedIncoming:0};
      if(toWh==='011'&&fromWh!=='011'){
        item.incoming+=qty;
        if(approvedTransferNumbers.has(source.transfer.number))item.approvedIncoming+=qty;
      }else if(fromWh==='011'&&toWh!=='011')item.outgoing+=qty;
      movement.set(key,item);
    }
  }
  return closing.map(row=>{
    const key=row.code+'|'+row.unit;
    const delta=movement.get(key)||{incoming:0,outgoing:0,approvedIncoming:0};
    const openingValue=starts.get(key)??null;
    const net=round(delta.incoming-delta.outgoing);
    const estimated=openingValue===null?null:round(openingValue+net);
    return {...row,opening:openingValue,incoming:round(delta.incoming),
      outgoing:round(delta.outgoing),netTransfers:net,
      approvedIncoming:round(delta.approvedIncoming),estimated,
      difference:estimated===null?null:round(row.quantity-estimated)};
  });
}
