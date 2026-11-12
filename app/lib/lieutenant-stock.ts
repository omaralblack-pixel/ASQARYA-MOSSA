import type {LieutenantTransfer} from './lieutenant';
import type {Item} from './reconcile';

export type LieutenantFileKind='transfers'|'opening'|'balance'|'other';
export type StockItem={code:string;name:string;warehouse:string;unit:string;quantity:number};
export type StockRead={items:StockItem[];issues:string[]};
export type StockAuditItem=Omit<StockItem,'quantity'>&{
  quantity:number|null;
  opening:number|null;incoming:number;outgoing:number;adjustment:number;netTransfers:number;
  approvedIncoming:number;estimated:number|null;difference:number|null;
  requiredIncoming:number;uncoveredIncoming:number|null;movementComplete:boolean;
  converted:boolean;openingAssumedZero:boolean;issues:string[];
};
const clean=(value:string)=>value.replace(/^\uFEFF/,'').toLowerCase()
  .replace(/[\s._\-:،#]+/g,'').trim();
const fields={
  code:['رقم الصنف','كود الصنف','رقم المادة','item no.','item no','itemcode'],
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
    if(fields.code.some(alias=>clean(at(row,'code'))===clean(alias)))continue;
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

/** An estimate from transfers, not the complete OINM journal. Unit conversions
 * require one unambiguous factor in the user's item reference; otherwise the
 * comparison stays incomplete. Missing actual SAP stock never means zero.
 * When an opening baseline is confirmed for the selected start date, item
 * codes absent from that baseline have an opening quantity of zero.
 */
export function auditLieutenantStock(
  closing:StockItem[],opening:StockItem[],transfers:LieutenantTransfer[],
  approvedTransferNumbers:ReadonlySet<string>,from:string,to:string,
  reference:Item[]=[],invoiceRequiredNumbers?:ReadonlySet<string>,
  openingConfirmed=false,
):StockAuditItem[]{
  const definitions=reference.filter(row=>row.active).flatMap(row=>[row,...(row.sapAliases||[])]);
  const convert=(qty:number,code:string,sourceUnit:string,targetUnit:string):number|null=>{
    if(sourceUnit===targetUnit)return qty;
    const factors=definitions.filter(row=>row.sapCode===code).flatMap(row=>{
      const piece=(unit:string)=>unit==='Piece'?1:unit==='Carton'?row.cartonPieces:
        unit==='KG'&&row.kgPerPiece&&row.kgPerPiece>0?1/row.kgPerPiece:null;
      const a=piece(sourceUnit),b=piece(targetUnit);
      return a&&a>0&&b&&b>0?[a/b]:[];
    });
    if(!factors.length||factors.some(value=>Math.abs(value-factors[0])>0.000001))return null;
    return qty*factors[0];
  };
  const items=new Map<string,StockItem>();
  for(const row of closing)items.set(row.code+'|'+normalizeUnit(row.unit),{...row,unit:normalizeUnit(row.unit)});
  const actualKeys=new Set(items.keys());
  // Include codes absent from the stock sheet, rather than silently dropping
  // their opening balance or movement from the report.
  const addMissing=(code:string,name:string,unit:string)=>{
    if(![...items.values()].some(row=>row.code===code))
      items.set(code+'|'+unit,{code,name,warehouse:'011',unit,quantity:0});
  };
  for(const row of opening.filter(row=>row.warehouse==='011'))addMissing(row.code,row.name,normalizeUnit(row.unit));
  for(const source of transfers){
    if(source.transfer.date&&(source.transfer.date<from||source.transfer.date>to))continue;
    for(const line of source.transfer.paste.split('\n').slice(1)){
      const [code,name,,unit]=line.split('\t');
      if(code&&unit)addMissing(code.toUpperCase(),name,normalizeUnit(unit));
    }
  }
  const movement=new Map<string,{incoming:number;outgoing:number;adjustment:number;approvedIncoming:number;requiredIncoming:number;converted:boolean;issues:Set<string>}>();
  for(const source of transfers){
    if(source.transfer.date&&(source.transfer.date<from||source.transfer.date>to)||
      source.cancellationState==='canceled'||source.cancellationState==='cancellation')continue;
    for(const line of source.transfer.paste.split('\n').slice(1)){
      const [code,,rawQty,rawUnit,rawFrom,rawTo]=line.split('\t');
      const qty=number(rawQty||'');
      const unit=normalizeUnit(rawUnit||'');
      const fromWh=normalizeWarehouse(rawFrom||''),toWh=normalizeWarehouse(rawTo||'');
      for(const target of [...items.values()].filter(row=>row.code===code.toUpperCase())){
        const key=target.code+'|'+target.unit;
        const item=movement.get(key)||{incoming:0,outgoing:0,adjustment:0,approvedIncoming:0,requiredIncoming:0,converted:false,issues:new Set<string>()};
        movement.set(key,item);
        if(source.issues.length||!source.transfer.date||!unit||!Number.isFinite(qty)){
          item.issues.add('الترحيل '+source.transfer.number+' يحتوي بيانات تحتاج مراجعة؛ الكميات غير مكتملة.');
          continue;
        }
        const converted=convert(qty,target.code,unit,target.unit);
        if(converted===null){
          item.issues.add('تحويل '+unit+' إلى '+target.unit+' غير معرّف بشكل موحّد للصنف.');
          continue;
        }
        item.converted ||= unit!==target.unit;
        if(qty<0){
          if(toWh==='011'&&fromWh!=='011')item.adjustment+=converted;
          else if(fromWh==='011'&&toWh!=='011')item.adjustment-=converted;
        }else if(toWh==='011'&&fromWh!=='011'){
          item.incoming+=converted;
          if(!invoiceRequiredNumbers||invoiceRequiredNumbers.has(source.transfer.number)){
            item.requiredIncoming+=converted;
            if(approvedTransferNumbers.has(source.transfer.number))item.approvedIncoming+=converted;
          }
        }else if(fromWh==='011'&&toWh!=='011')item.outgoing+=converted;
      }
    }
  }
  return [...items.values()].map(row=>{
    const key=row.code+'|'+row.unit;
    const delta=movement.get(key)||{incoming:0,outgoing:0,adjustment:0,approvedIncoming:0,requiredIncoming:0,converted:false,issues:new Set<string>()};
    const starts=opening.filter(item=>item.warehouse==='011'&&item.code===row.code)
      .map(item=>convert(item.quantity,row.code,normalizeUnit(item.unit),row.unit));
    const openingAssumedZero=starts.length===0&&openingConfirmed;
    const openingValue=openingAssumedZero?0:
      starts.length&&starts.every(value=>value!==null)&&
      starts.every(value=>Math.abs(value!-starts[0]!)<0.000001)?round(starts[0]!):null;
    if(starts.length&&openingValue===null)delta.issues.add('الرصيد الافتتاحي بوحدة مختلفة أو بتعريفات متعارضة.');
    const net=round(delta.incoming-delta.outgoing+delta.adjustment);
    const complete=delta.issues.size===0;
    const estimated=openingValue===null||!complete?null:round(openingValue+net);
    const actual=actualKeys.has(key)?row.quantity:null;
    const notes=[...delta.issues];
    if(actual===null)notes.push('الصنف غير موجود بكشف رصيد SAP؛ لا يُفترض أن رصيده صفر.');
    return {...row,quantity:actual,opening:openingValue,incoming:round(delta.incoming),
      outgoing:round(delta.outgoing),adjustment:round(delta.adjustment),netTransfers:net,
      requiredIncoming:round(delta.requiredIncoming),approvedIncoming:round(delta.approvedIncoming),
      uncoveredIncoming:complete?round(delta.requiredIncoming-delta.approvedIncoming):null,
      movementComplete:complete,converted:delta.converted,openingAssumedZero,issues:notes,estimated,
      difference:estimated===null||actual===null?null:round(actual-estimated)};
  });
}
