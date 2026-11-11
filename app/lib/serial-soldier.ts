import {digits, fils, invoiceDocumentNo, dateValue, pageNumber, parseTransfer, sapReferences, soldierLineKey, transferNumbers, type Draft} from './reconcile';


export type SerialInput = {row:number; number:string; amount:string; date:string};
export type SerialState = 'received'|'pending'|'missing'|'review';
export type SerialTransfer = {number:string; kind:'main'|'dry'|'adjustment'};
export type SerialRow = SerialInput & {state:SerialState; reason:string; transfers:SerialTransfer[]; unassignedTransfers:SerialTransfer[]; branch:string};
export type SerialRecord = {id:string; branch:string; status?:string; payload:string};
export type SerialReport = {rows:SerialRow[]; blockers:string[]; legacyWarnings:string[]; count:{received:number;pending:number;missing:number;review:number}};

// Existing matched records dated before the new workflow do not need historic page numbers.
export const LEGACY_PAGE_CUTOFF='2026-11-11';
type Saved = {record:SerialRecord; draft:Draft; invoice:Draft['invoices'][number]; index:number};
function normalNumber(value:unknown) {
  return invoiceDocumentNo(value).replace(/[,٬]/g,'');
}
function serialTransfer(draft:Draft, saved:Saved, owner:Map<string,string>, blockers:string[], warnings:string[]) {
  const assigned:SerialTransfer[]=[];
  const unassigned:SerialTransfer[]=[];
  const references=new Map(sapReferences(draft.referenceSnapshot||[]).map(item=>[item.sapCode,item.code]));
  const multi=draft.invoices.length>1;
  const savedDate=dateValue(saved.invoice.date||'');
  const summary=(draft as Draft&{summary?:{status?:string}}).summary;
  // The owner's approved MATCH is authoritative for the old group. Only PAGE ownership
  // is exempted. This does NOT assert that a group transfer belongs to a specific invoice.
  const acceptedOldGroup=multi&&!!savedDate&&savedDate<LEGACY_PAGE_CUTOFF&&
    (summary?.status==='match'||(!summary?.status&&saved.record.status==='match'));
  for(const transfer of draft.transfers||[]){
    const numbers=transferNumbers(transfer.number||'');
    if(numbers.length!==1||!/^\d{4,20}$/.test(numbers[0])){
      blockers.push('فاتورة '+saved.invoice.number+': رقم ترحيل مركب أو غير صالح؛ لا يمكن تحديد اتجاه كل رقم بثقة.');
      continue;
    }
    const number=numbers[0];
    const previous=owner.get(number);
    if(previous&&previous!==saved.record.id)blockers.push('الترحيل '+number+' مكرر في سجلين مختلفين ('+previous+'، '+saved.record.id+').');
    else owner.set(number,saved.record.id);
    const p=parseTransfer(transfer.paste||'',{allowReverse:true});
    if(p.issues.length||p.excluded.length||!p.lines.length){
      blockers.push('الترحيل '+number+': بنود غير مقروءة أو خارج المسارات المعتمدة؛ لا يجوز تصنيفه دون مراجعة.');
      continue;
    }
    const routes=new Set(p.lines.map(line=>line.from+'>'+line.to));
    // A single SAP document can contain more than one warehouse route.
    // Its number is listed under adjustments, never arbitrarily assigned to main or dry.
    const route=routes.size===1?[...routes][0]:null;
    const kind=route==='001>011'?'main':route==='002>011'?'dry':'adjustment';
    if(multi){
      const linked=new Set<number>();
      let ambiguous=false;
      for(const line of p.lines){
        if(draft.soldierLineAllocations!==undefined){
          const key=soldierLineKey(transfer.id,line);
          const pieces=draft.soldierLineAllocations[key];
          const expected=draft.soldierLineTotals?.[key];
          if(!pieces||!expected||!Number.isFinite(expected)||expected<=0||
            !Object.keys(pieces).length||
            Object.entries(pieces).some(([pg,qty])=>!/^\d+$/.test(pg)||+pg<1||+pg>draft.invoices.length||
              !Number.isFinite(qty)||qty<=0)||
            Math.abs(Object.values(pieces).reduce((s,v)=>s+v,0)-expected)>0.000001){
            ambiguous=true;break;
          }
          Object.keys(pieces).forEach(pg=>linked.add(Number(pg)-1));
          continue;
        }
        const code=references.get(line.sapCode);
        const key=code&&draft.pages?.['i:'+code]?'i:'+code:'s:'+line.sapCode;
        const pg=pageNumber(draft.pages?.[key]);
        if(!pg||pg>draft.invoices.length){ambiguous=true;break;}
        linked.add(pg-1);
      }
      if(ambiguous||!linked.size){
        if(acceptedOldGroup){
          // The transfer is CONFIRMED on the approved saved group, not on an individual
          // invoice page. Keep it in a distinct group-level output field for accuracy.
          unassigned.push({number,kind});
          warnings.push('الترحيل '+number+' معتمد ضمن مجموعة الفواتير القديمة التي تشمل '+saved.invoice.number+
            '؛ تم استثناء شرط أرقام الصفحات فقط.');
        }else{
          blockers.push('الترحيل '+number+': مجموعة متعددة الفواتير، ولا يمكن ربط جميع بنوده بصفحات فواتير محددة.');
        }
        continue;
      }
      if(!linked.has(saved.index))continue;
    }
    if(assigned.some(row=>row.number===number)){
      blockers.push('الترحيل '+number+' مكرر داخل الفاتورة '+saved.invoice.number+'.');
      continue;
    }
    assigned.push({number,kind});
  }
  return {assigned,unassigned};
}
export function evaluateSerial(rows:SerialInput[], records:SerialRecord[]):SerialReport {
  const blockers:string[]=[], legacyWarnings:string[]=[];
  const index=new Map<string,Saved[]>();
  const transferOwner=new Map<string,string>();
  for(const record of records){
    let draft:Draft;
    try{draft=JSON.parse(record.payload) as Draft;}
    catch{blockers.push('سجل تالف تعذّر قراءته: '+record.id);continue;}
    if(!Array.isArray(draft.invoices)||!Array.isArray(draft.transfers)){
      blockers.push('سجل فواتير ناقص: '+record.id);continue;
    }
    for(const [i,invoice] of draft.invoices.entries()){
      const number=normalNumber(invoice.number);
      if(!number)continue;
      const saved={record,draft,invoice,index:i};
      index.set(number,[...(index.get(number)||[]),saved]);
    }
  }
  const inSheet=new Map<string,number>();
  const result:SerialRow[]=rows.map(row=>{
    const number=normalNumber(row.number);
    const key=number;
    const base={...row,number,state:'missing' as SerialState,reason:'غير موجودة في السجل',transfers:[] as SerialTransfer[],unassignedTransfers:[] as SerialTransfer[],branch:''};
    if(!/^\d{8,20}$/.test(number)){
      blockers.push('صف '+row.row+': رقم فاتورة مفقود أو غير صالح.');
      return {...base,state:'review',reason:'رقم فاتورة غير صالح'};
    }
    if(inSheet.has(key)){
      blockers.push('رقم الفاتورة '+number+' مكرر في صفّي '+inSheet.get(key)+' و'+row.row+' من Excel سجى.');
      return {...base,state:'review',reason:'رقم فاتورة مكرر في Excel'};
    }
    inSheet.set(key,row.row);
    const candidates=index.get(number)||[];
    if(candidates.length>1){
      blockers.push('رقم الفاتورة '+number+' مكرر في سجلات المشروع ('+candidates.length+' مرات).');
      return {...base,state:'review',reason:'رقم الفاتورة مكرر في سجلات المشروع'};
    }
    if(!candidates.length)return base;
    const saved=candidates[0], amount=fils(row.amount);
    const confirmed=fils(saved.invoice.amount||'');
    const linked=serialTransfer(saved.draft,saved,transferOwner,blockers,legacyWarnings);
    const transfers=linked.assigned, unassignedTransfers=linked.unassigned;
    if(!transfers.length&&!unassignedTransfers.length)blockers.push('فاتورة '+number+': لم يتم التحقق من أي ترحيل مرتبط بها.');
    const payloadSummary=(saved.draft as Draft & {summary?:{status?:string}}).summary;
    const approvedStatus=payloadSummary?.status||saved.record.status;
    const rowBase={...base,transfers,unassignedTransfers,branch:saved.record.branch||''};
    if(amount===null||confirmed===null){
      blockers.push('فاتورة '+number+': مبلغ غير صالح أو مفقود في ملف سجى أو سجل المشروع.');
      return {...rowBase,state:'review',reason:'المبلغ غير صالح أو مفقود'};
    }
    if(amount!==confirmed)return {...rowBase,state:'review',reason:'فرق مبلغ: سجى '+row.amount+' / السجل '+saved.invoice.amount};
    if(saved.invoice.complete!==true)return {...rowBase,state:'pending',reason:'الفاتورة محفوظة لكن الورق غير مؤكد'};
    if(approvedStatus&&approvedStatus!=='match')return {...rowBase,state:'review',reason:'المطابقة المحفوظة غير معتمدة: '+approvedStatus};
    return {...rowBase,state:'received',reason:'رقم الفاتورة والمبلغ مؤكدان'};
  });
  const count={received:0,pending:0,missing:0,review:0};
  for(const row of result)count[row.state]++;
  return {rows:result,blockers:[...new Set(blockers)],legacyWarnings:[...new Set(legacyWarnings)],count};
}
export function serialColumns(transfers:SerialTransfer[]):string[] {
  const seen=new Set<string>();
  const uniq=transfers.filter(t=>{if(seen.has(t.number))return false;seen.add(t.number);return true;});
  const main=uniq.filter(t=>t.kind==='main'),dry=uniq.filter(t=>t.kind==='dry');
  const others=uniq.filter(t=>t.kind==='adjustment');
  return [main.shift()?.number||'',dry.shift()?.number||'',...main.map(t=>t.number),...dry.map(t=>t.number),...others.map(t=>t.number)];
}
