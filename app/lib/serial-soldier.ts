import {digits, fils, invoiceDocumentNo, dateValue, parseTransfer, readReconciliationRecord, transferNumbers, type Draft} from './reconcile';
import {collectInvoicesByDate} from './invoice-collector';


export const PROJECT_ONLY_NOTE='موجودة بالمشروع وغير موجودة بكشف سجى';
export type SerialPeriod = {from:string;to:string};
export type SerialInput = {row:number; number:string; amount:string; date:string; workbookBranch?:string; originalTransfers?:string[]; origin?:'project'};
export type SerialState = 'received'|'received_difference'|'pending'|'missing'|'review';

/** A merge is a proposed, per-file operation. No rows are changed until the user
 * explicitly approves the invoice number. Material conflicts block merging.
 */
export type SerialMergeProposal = {
 number:string;keepRow:number;removeRows:number[];allRows:number[];
 canMerge:boolean;reason:string;amounts:string[];dates:string[];branches:string[];
};
export function serialMergeProposals(rows:SerialInput[]):SerialMergeProposal[]{
 const groups=new Map<string,SerialInput[]>();
 for(const row of rows){
  const number=invoiceDocumentNo(row.number).replace(/[,٬]/g,'');
  if(!/^\d{8,20}$/.test(number))continue;
  groups.set(number,[...(groups.get(number)||[]),row]);
 }
 const proposals:SerialMergeProposal[]=[];
 for(const [number,copies] of groups){
  if(copies.length<2)continue;
  const order=[...copies].sort((a,b)=>Number(a.origin==='project')-Number(b.origin==='project')||a.row-b.row);
  const amounts=[...new Set(copies.map(row=>String(row.amount||'').trim()))];
  const amountValues=copies.map(row=>fils(row.amount));
  const parsedDates=copies.map(row=>dateValue(row.date)||'');
  const dates=[...new Set(parsedDates.filter(Boolean))];
  const rawBranches=copies.map(row=>String(row.workbookBranch||'').trim());
  const branches=[...new Set(rawBranches.filter(Boolean))];
  const conflict=amountValues.some(value=>value===null)||new Set(amountValues).size>1||
    parsedDates.some(date=>!date)||new Set(parsedDates).size>1||
    new Set(rawBranches).size>1;
  proposals.push({
   number,keepRow:order[0].row,removeRows:order.slice(1).map(row=>row.row),
   allRows:copies.map(row=>row.row).sort((a,b)=>a-b),canMerge:!conflict,
   reason:conflict?'اختلاف في المبلغ أو التاريخ أو الفرع؛ راجع القيم قبل الدمج.':
    'متطابقة في رقم الفاتورة والمبلغ والتاريخ والفرع؛ يلزم موافقتك على الدمج.',
   amounts,dates,branches,
  });
 }
 return proposals.sort((a,b)=>a.keepRow-b.keepRow);
}

/** Program-generated blue rows from older exports must never duplicate a Saja
 * row or another blue row. Map each removable row to its surviving source row.
 * Original Saja rows are ALWAYS retained for audit, even when Saja itself repeats.
 */
export function duplicateGeneratedSerialRows(rows:SerialInput[]):Map<number,number>{
 const original=new Map<string,number>(),blue=new Map<string,number>(),removed=new Map<number,number>();
 for(const row of rows){
  const number=invoiceDocumentNo(row.number).replace(/[,٬]/g,'');
  if(row.origin!=='project'&&/^\d{8,20}$/.test(number)&&!original.has(number))
   original.set(number,row.row);
 }
 for(const row of rows){
  if(row.origin!=='project')continue;
  const number=invoiceDocumentNo(row.number).replace(/[,٬]/g,'');
  if(!/^\d{8,20}$/.test(number))continue;
  const surviving=original.get(number)??blue.get(number);
  if(surviving!==undefined)removed.set(row.row,surviving);
  else blue.set(number,row.row);
 }
 return removed;
}

export type SerialTransfer = {number:string; kind:'main'|'dry'|'adjustment'};
export type SerialRow = SerialInput & {state:SerialState; reason:string; transfers:SerialTransfer[]; unassignedTransfers:SerialTransfer[]; branch:string; omarNumber:string; omarAmount:string};
export type SerialRecord = {id:string; branch:string; status?:string; payload:string};
export type SerialReport = {rows:SerialRow[]; projectOnly:SerialRow[]; period:SerialPeriod|null; blockers:string[]; legacyWarnings:string[]; count:{received:number;pending:number;missing:number;review:number}};

type Saved = {record:SerialRecord; draft:Draft; invoice:Draft['invoices'][number]; index:number};
function normalNumber(value:unknown) {
  return invoiceDocumentNo(value).replace(/[,٬]/g,'');
}
function serialTransfer(draft:Draft, saved:Saved, owner:Map<string,string>, blockers:string[], warnings:string[]) {
  const assigned:SerialTransfer[]=[];
  const unassigned:SerialTransfer[]=[];
  const multi=draft.invoices.length>1;
  // A transfer belongs to its saved group. A personal page number is not evidence
  // that it belongs to a specific paper invoice within a multi-invoice group.
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
      // Keep valid transfer numbers visible on EVERY invoice in the group, but
      // never attribute an individual SAP line or amount to one invoice by page.
      // Unassigned here means group-linked, NOT an error and NOT unreceived.
      if(!unassigned.some(row=>row.number===number))unassigned.push({number,kind});
      continue;
    }
    if(assigned.some(row=>row.number===number)){
      blockers.push('الترحيل '+number+' مكرر داخل الفاتورة '+saved.invoice.number+'.');
      continue;
    }
    assigned.push({number,kind});
  }
  return {assigned,unassigned};
}
export function evaluateSerial(rows:SerialInput[], records:SerialRecord[],period?:SerialPeriod|null):SerialReport {
  const blockers:string[]=[], legacyWarnings:string[]=[];
  const index=new Map<string,Saved[]>();
  // A Saja typo can be associated with Omar's record only when an existing SAP transfer
  // points to exactly one invoice. Never guess based on similar amounts or dates.
  const transferIndex=new Map<string,Saved[]>();
  const transferOwner=new Map<string,string>();
  for(const record of records){
    const draft=readReconciliationRecord(record.payload);
    if(!draft){
      blockers.push('سجل فواتير ناقص: '+record.id);continue;
    }
    const numbered=draft.invoices.map((invoice,i)=>({record,draft,invoice,index:i})).filter(saved=>normalNumber(saved.invoice.number));
    for(const saved of numbered){
      const number=normalNumber(saved.invoice.number);
      index.set(number,[...(index.get(number)||[]),saved]);
    }
    if(numbered.length===1){
      for(const transfer of draft.transfers){
        const numbers=transferNumbers(transfer.number||'');
        if(numbers.length!==1||!/^\d{4,20}$/.test(numbers[0]))continue;
        const number=numbers[0];
        const current=transferIndex.get(number)||[];
        if(!current.some(item=>item.record.id===record.id))
          transferIndex.set(number,[...current,numbered[0]]);
      }
    }
  }
  const inSheet=new Map<string,number>();
  const represented=new Set<string>();
  const evaluate=(row:SerialInput):SerialRow=>{
    const number=normalNumber(row.number);
    const key=number;
    const base={...row,number,state:'missing' as SerialState,reason:'غير موجودة في سجل المطابقة؛ لا يعني أن ورقها غير واصل',transfers:[] as SerialTransfer[],unassignedTransfers:[] as SerialTransfer[],branch:'',omarNumber:'',omarAmount:''};
    if(!/^\d{8,20}$/.test(number)){
      blockers.push('صف '+row.row+': رقم فاتورة مفقود أو غير صالح.');
      return {...base,state:'review',reason:'رقم فاتورة غير صالح'};
    }
    if(row.row>0&&inSheet.has(key)){
      blockers.push('رقم الفاتورة '+number+' مكرر في صفّي '+inSheet.get(key)+' و'+row.row+' من Excel سجى.');
      return {...base,state:'review',reason:'رقم فاتورة مكرر في Excel'};
    }
    if(row.row>0)inSheet.set(key,row.row);
    let candidates=index.get(number)||[];
    let matchedByTransfer=false;
    if(!candidates.length&&row.originalTransfers?.length){
      const possible=new Map<string,Saved>();
      for(const transfer of row.originalTransfers)
        for(const saved of transferIndex.get(transfer)||[])
          possible.set(saved.record.id+':'+saved.index,saved);
      if(possible.size===1){
        candidates=[...possible.values()];
        matchedByTransfer=true;
      }
    }
    if(candidates.length>1){
      // Collapse conflicting saved records into ONE invoice-number projection.
      // Preserve every record and transfer in the database, and surface disagreements.
      const amounts=[...new Set(candidates.map(saved=>String(saved.invoice.amount||'')))];
      const branches=[...new Set(candidates.map(saved=>saved.record.branch||'').filter(Boolean))];
      const dates=[...new Set(candidates.map(saved=>dateValue(saved.invoice.date||'')).filter(Boolean))];
      const links=candidates.map(saved=>serialTransfer(saved.draft,saved,transferOwner,blockers,legacyWarnings));
      const transfers=[...new Map(links.flatMap(link=>link.assigned).map(t=>[t.number,t])).values()];
      const unassignedTransfers=[...new Map(links.flatMap(link=>link.unassigned).map(t=>[t.number,t])).values()]
        .filter(t=>!transfers.some(link=>link.number===t.number));
      const conflicts=[
        'رقم الفاتورة مكرر في سجلات المشروع ('+candidates.length+' مرات؛ السجلات: '+
          [...new Set(candidates.map(saved=>saved.record.id))].join('، ')+')',
        ...(amounts.length>1?['المبالغ المختلفة: '+amounts.join(' / ')]:[]),
        ...(branches.length>1?['الفروع المختلفة: '+branches.join(' / ')]:[]),
        ...(dates.length>1?['التواريخ المختلفة: '+dates.join(' / ')]:[]),
      ];
      blockers.push('رقم الفاتورة '+number+': '+conflicts.join('؛ ')+'.');
      for(const saved of candidates)
        represented.add(saved.record.id+'|'+number);
      return {...base,state:'review',reason:conflicts.join('؛ '),
        branch:branches.join(' / '),omarNumber:number,omarAmount:amounts.length===1?amounts[0]:'',
        transfers,unassignedTransfers};
    }
    if(!candidates.length)return base;
    const saved=candidates[0], amount=fils(row.amount);
    represented.add(saved.record.id+'|'+normalNumber(saved.invoice.number));
    const confirmed=fils(saved.invoice.amount||'');
    const errorsBefore=blockers.length;
    const linked=serialTransfer(saved.draft,saved,transferOwner,blockers,legacyWarnings);
    const transferHasErrors=blockers.length>errorsBefore;
    const transfers=linked.assigned, unassignedTransfers=linked.unassigned;
    if(!transfers.length&&!unassignedTransfers.length)blockers.push('فاتورة '+number+': لم يتم التحقق من أي ترحيل مرتبط بها.');
    const payloadSummary=(saved.draft as Draft & {summary?:{status?:string}}).summary;
    const approvedStatus=payloadSummary?.status||saved.record.status;
    const omarNumber=normalNumber(saved.invoice.number),omarAmount=String(saved.invoice.amount||'');
    const rowBase={...base,transfers,unassignedTransfers,branch:saved.record.branch||'',omarNumber,omarAmount};
    if(amount===null||confirmed===null){
      blockers.push('فاتورة '+number+': مبلغ غير صالح أو مفقود في ملف سجى أو سجل المشروع.');
      return {...rowBase,state:'review',reason:'المبلغ غير صالح أو مفقود'};
    }
    // Receipt is a separate fact from invoice number/amount equality. A confirmed,
    // approved invoice linked by a unique SAP transfer is received even if Saja
    // mistyped its number or amount; discrepancies are retained in notes.
    if(saved.invoice.complete!==true)return {...rowBase,state:'pending',reason:'الفاتورة محفوظة لكن الورق غير مؤكد'};
    if(approvedStatus&&approvedStatus!=='match')return {...rowBase,state:'review',reason:'المطابقة المحفوظة غير معتمدة: '+approvedStatus};
    if(transferHasErrors)return {...rowBase,state:'review',reason:'يوجد خطأ في ربط أو تصنيف الترحيلات؛ راجع أرقام الترحيلات'};
    if(!transfers.length&&!unassignedTransfers.length)return {...rowBase,state:'review',reason:'لم يتم التحقق من أي ترحيل مرتبط بالفاتورة'};
    if(matchedByTransfer||amount!==confirmed)
      return {...rowBase,state:'received_difference',reason:'الفاتورة واصلة، مع فرق موضح بالملاحظات'};
    return {...rowBase,state:'received',reason:'رقم الفاتورة والمبلغ مؤكدان'};
  };
  const result=rows.map(evaluate);
  const dates=rows.map(row=>dateValue(row.date)).filter((date):date is string=>!!date).sort();
  const scope=period|| (dates.length?{from:dates[0],to:dates[dates.length-1]}:null);
  const projectOnly:SerialRow[]=[];
  if(scope){
    const collected=collectInvoicesByDate(records,scope.from,scope.to);
    const inWorkbook=new Set(rows.map(row=>normalNumber(row.number)));
    const appended=new Set<string>();
    for(const invoice of collected.rows){
      const number=normalNumber(invoice.number),key=invoice.recordId+'|'+number;
      if(!/^\d{8,20}$/.test(number)||inWorkbook.has(number)||represented.has(key)||appended.has(number))continue;
      // Deduplicate by invoice NUMBER, never by record ID. A conflicting
      // project record becomes a review note on this one exported invoice.
      appended.add(number);
      const checked=evaluate({row:-(projectOnly.length+1),number,amount:invoice.amount,date:invoice.date,origin:'project'});
      projectOnly.push({...checked,branch:invoice.branch,omarNumber:number,omarAmount:invoice.amount});
    }
    if(collected.undatedInvoices)
      legacyWarnings.push('يوجد '+collected.undatedInvoices+' فاتورة في المشروع بلا تاريخ صالح؛ لم تُنسب إلى فترة كشف سجى.');
  }
  const count={received:0,pending:0,missing:0,review:0};
  for(const row of result){
    if(row.origin==='project')continue;
    if(row.state==='received_difference')count.received++;
    else count[row.state]++;
  }
  return {rows:result,projectOnly,period:scope,blockers:[...new Set(blockers)],legacyWarnings:[...new Set(legacyWarnings)],count};
}
/** Only describe exceptions; approved rows should never receive repeated Omar/Saja values. */
export function serialReviewNote(row:SerialRow):string {
 if(row.state==='received'&&row.origin!=='project')return '';
 const parts:string[]=row.origin==='project'?[PROJECT_ONLY_NOTE]:[];
 if(row.omarNumber&&row.number&&row.omarNumber!==row.number)
   parts.push('فرق رقم الفاتورة: عمر '+row.omarNumber+'، سجى '+row.number);
 if(row.omarAmount&&row.amount){
   const omar=fils(row.omarAmount),saja=fils(row.amount);
   if(omar!==null&&saja!==null&&omar!==saja)
     parts.push('فرق المبلغ: عمر '+(omar/1000).toFixed(3)+' د.أ، سجى '+(saja/1000).toFixed(3)+' د.أ');
 }
 // A discrepancy must not hide a separate pending/unapproved validation issue.
 if(row.state==='pending')parts.push('ورق الفاتورة غير مؤكد في سجل عمر');
 else if(row.state==='review'&&row.reason)parts.push(row.reason);
 else if(!parts.length&&row.state==='missing')
   parts.push('غير موجودة في سجل المطابقة؛ لا يمكن استنتاج وصول الورق من غياب التسجيل');
 return parts.join(' | ');
}
// Read-only export projection: show confirmed shared group transfers on each invoice
// row without writing page ownership into the underlying reconciled group.
export function serialInvoiceColumns(row:Pick<SerialRow,'transfers'|'unassignedTransfers'>):string[]{
 return serialColumns([...row.transfers,...row.unassignedTransfers]);
}
export function serialColumns(transfers:SerialTransfer[]):string[] {
  const seen=new Set<string>();
  const uniq=transfers.filter(t=>{if(seen.has(t.number))return false;seen.add(t.number);return true;});
  const main=uniq.filter(t=>t.kind==='main'),dry=uniq.filter(t=>t.kind==='dry');
  const others=uniq.filter(t=>t.kind==='adjustment');
  return [main.shift()?.number||'',dry.shift()?.number||'',...main.map(t=>t.number),...dry.map(t=>t.number),...others.map(t=>t.number)];
}
