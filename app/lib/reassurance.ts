import {collectInvoicesByDate,type CollectedInvoiceResult} from './invoice-collector';
import {auditLieutenantStock,completeOpeningSnapshot,type StockItem} from './lieutenant-stock';
import {stockMovementSources} from './lieutenant-stock';
import {digits,invoiceDocumentNo,numeric,parseTransfer,readReconciliationRecord,sapReferences,signedNumeric,transferNumbers,
  type Draft,type Item} from './reconcile';
import {parseLieutenantTransfers,type LieutenantTransfer} from './lieutenant';
import {mergeLieutenantScans,type RestoredLieutenantSource} from './lieutenant-source';
import type {SavedSapImport} from './saved-sap-import';

export type ReassuranceRecord={id:string;branch:string;status:string;payload:string};
export type OpeningApproval={snapshot_date:string;warehouse:string;sap_code:string;item_name:string;unit:string;quantity:number};
export type ReassuranceData=CollectedInvoiceResult&{records:ReassuranceRecord[];reference:Item[];openingStock:OpeningApproval[]};
export type ReassuranceStock={date:string;items:StockItem[];issues:string[]};
export type ReassuranceState='match'|'transfer'|'return'|'review';
export type ReassuranceEvidence={number:string;date:string;direction:string;quantity:number;unit:string;remarks:string};
export type ReassuranceCancellationCandidate={number:string;date:string;branch:string;quantity:number;
  direction:string;itemCount:number;invoiceNumbers:string[];cancellationState:'active'|'unknown';
  stockUnexplained:boolean};
export type ReassuranceRow={code:string;name:string;unit:'Piece';invoices:number|null;opening:number|null;expected:number|null;
  actual:number|null;difference:number|null;netTransfers:number|null;stockDifference:number|null;
  state:ReassuranceState;notes:string[];records:{id:string;numbers:string[];basis:'paper'|'approved'}[];evidence:ReassuranceEvidence[];candidates:ReassuranceCancellationCandidate[]};
export type ReassuranceReport={rows:ReassuranceRow[];issues:string[];invoiceCount:number;approvedGroups:number;
  pendingRecords:{id:string;numbers:string[];branch:string;note:string}[];sourceLastDate:string;financialPending:number;paperGroups:number;state:ReassuranceState};
const epsilon=0.000001;
const round=(n:number)=>Number(n.toFixed(6));
const unitName=(unit:string)=>({حبة:'Piece',كرتون:'Carton',كرتونة:'Carton',كغم:'KG'}[unit]||unit);

/** Prefer the dated newest source without losing recovered cancellation originals.
 * On equal posting dates the archive's newest upload remains authoritative. */
export function reassuranceSource(archive:RestoredLieutenantSource|null,shared:SavedSapImport|undefined,branches:string[]){
  const last=(rows:LieutenantTransfer[])=>rows.reduce((day,row)=>row.transfer.date>day?row.transfer.date:day,'');
  const current=shared?parseLieutenantTransfers(shared.text,branches):null;
  if(current?.transfers.length&&(!archive||last(current.transfers)>last(archive.scan.transfers)))
    return {scan:archive?mergeLieutenantScans(current,archive.scan):current,
      name:shared!.name+(archive?' + مستندات SAP المحفوظة':'')};
  return {scan:archive?.scan,name:archive?.name||''};
}

/** Convert only with one agreed factor. A missing factor is never a quantity of zero. */
function pieces(quantity:number,unit:string,code:string,reference:Item[]):number|null{
  unit=unitName(unit);
  if(unit==='Piece')return round(quantity);
  const factors=sapReferences(reference).filter(item=>item.active&&item.sapCode.toUpperCase()===code)
    .map(item=>unit==='Carton'?item.cartonPieces:unit==='KG'&&item.kgPerPiece?1/item.kgPerPiece:null);
  if(!factors.length||factors.some(n=>n===null||!Number.isFinite(n)||n<=0)||
    factors.some(n=>Math.abs(n!-factors[0]!)>epsilon))return null;
  return round(quantity*factors[0]!);
}

function paper(invoice:Draft['invoices'][number]){
  const values=new Map<string,number>(),issues:string[]=[];
  const source=invoice.auditLines?.trim()?invoice.auditLines:
    Object.entries(invoice.quantities||{}).map(([code,qty])=>code+'\t'+qty).join('\n');
  for(const line of source.replace(/\r/g,'').split('\n')){
    if(!line.trim())continue;
    const [rawCode,rawQuantity]=line.split('\t');
    if(/^(?:رقم\s*(?:المادة|الصنف)|item\s*(?:no|code)|code)/i.test(rawCode||''))continue;
    const code=digits(rawCode||'').trim(),quantity=numeric(rawQuantity);
    if(!/^\d{8}$/.test(code)||quantity===null){issues.push('كود أو كمية غير صالحة في الفاتورة '+invoice.number);continue;}
    values.set(code,(values.get(code)||0)+quantity);
  }
  return {values,known:invoice.complete&&values.size>0&&issues.length===0};
}

/** A document can be proposed for review only when removing its complete SAP
 * movement would eliminate EVERY affected item difference. Quantity coincidence
 * on one line is insufficient, especially for multi-item transfers.
 * Suggestions are never proof that an SAP document is erroneous or may be canceled. */
function cancellationCandidates(rows:ReassuranceRow[],transfers:LieutenantTransfer[],
  records:ReassuranceRecord[],reference:Item[],from:string,to:string){
  const linked=new Set<string>();
  for(const record of records){
    const draft=readReconciliationRecord(record.payload);
    if(!draft)continue;
    for(const transfer of draft.transfers||[])
      for(const number of transferNumbers(transfer.number||''))linked.add(number);
  }
  const byCode=new Map(rows.map(row=>[row.code,row]));
  const result=new Map<string,ReassuranceCancellationCandidate[]>();
  const sources=stockMovementSources(transfers);
  const counts=new Map<string,number>();
  for(const source of sources)counts.set(source.transfer.number,(counts.get(source.transfer.number)||0)+1);
  const warehouse=(raw:string)=>/^\d+$/.test(raw.trim())?raw.trim().padStart(3,'0'):raw.trim();
  for(const source of sources){
    const number=source.transfer.number;
    if(!number||counts.get(number)!==1||linked.has(number)||source.issues.length||
      source.signedAdjustment||source.cancellationMentioned||
      source.cancellationState==='canceled'||source.cancellationState==='cancellation'||
      source.transfer.date<from||source.transfer.date>to)continue;
    const lines=source.transfer.paste.replace(/\r/g,'').split('\n').slice(1).filter(line=>line.trim());
    if(!lines.length)continue;
    const impacts=new Map<string,number>();
    let invalid=false;
    for(const line of lines){
      const [rawCode,,rawQty,unit,rawFrom,rawTo]=line.split('\t');
      const code=(rawCode||'').trim().toUpperCase();
      const qty=signedNumeric(rawQty||''),fromWh=warehouse(rawFrom||''),toWh=warehouse(rawTo||'');
      if(!code||!unit||qty===null||qty<=0||fromWh===toWh||
        !(fromWh==='011'||toWh==='011')||(fromWh==='011'&&toWh==='011')){invalid=true;break;}
      const converted=pieces(qty,unit,code,reference);
      if(converted===null){invalid=true;break;}
      const signed=toWh==='011'?converted:-converted;
      impacts.set(code,round((impacts.get(code)||0)+signed));
    }
    if(invalid||!impacts.size)continue;
    // A complete cancellation changes the stock of every code on the document.
    // Do not recommend an action based only on the line matching the chosen item.
    const affected=[...impacts].map(([code,impact])=>({row:byCode.get(code),code,impact}));
    if(affected.some(({row,impact})=>!row||row.difference===null||
      Math.abs(row.difference-impact)>epsilon))continue;
    const stockUnexplained=affected.some(({row})=>row!.stockDifference===null||
      Math.abs(row!.stockDifference)>epsilon||row!.notes.length>0);
    for(const {code,impact} of affected){
      if(Math.abs(impact)<epsilon)continue;
      const candidate:ReassuranceCancellationCandidate={number,date:source.transfer.date,
        branch:source.branch,quantity:Math.abs(impact),
        direction:impact>0?'إلغاء وارد إلى 011':'إلغاء صادر من 011',
        itemCount:impacts.size,invoiceNumbers:source.invoiceNumbers,
        cancellationState:source.cancellationState==='active'?'active':'unknown',
        stockUnexplained};
      result.set(code,[...(result.get(code)||[]),candidate]);
    }
  }
  return result;
}

/** Compare invoice demand with actual dated 011 stock. Financial approvals stay
 * untouched. A fully selected approved group may use its frozen reviewed SAP
 * quantities once, without inventing allocations to its individual invoices. */
export function reassure(input:{data:ReassuranceData;transfers:LieutenantTransfer[];sourceIssues:string[];
  closing:ReassuranceStock|null;opening:ReassuranceStock|null;from:string;to:string}):ReassuranceReport{
  const {data,transfers,closing,opening,from,to}=input;
  const issues:string[]=[...input.sourceIssues];
  const pendingRecords:ReassuranceReport['pendingRecords']=[];
  const totals=new Map<string,{name:string;quantity:number;records:ReassuranceRow['records']}>();
  const collected=collectInvoicesByDate(data.records,from,to);
  const selected=new Map<string,Set<string>>();
  const duplicateInvoices=new Map<string,number>();
  for(const row of collected.rows){
    if(!invoiceDocumentNo(row.number))continue;
    selected.set(row.recordId,new Set([...(selected.get(row.recordId)||[]),row.invoiceId]));
    const key=row.branch+'|'+row.number;
    duplicateInvoices.set(key,(duplicateInvoices.get(key)||0)+1);
  }
  if(collected.unreadableRecords||data.unreadableRecords)issues.push('توجد سجلات غير قابلة للقراءة؛ الفحص غير مكتمل.');
  const undatedNumbered=(result:CollectedInvoiceResult)=>result.undatedDetails.some(row=>!!invoiceDocumentNo(row.number))||
    result.undatedInvoices>result.undatedDetails.length;
  if(undatedNumbered(collected)||undatedNumbered(data))issues.push('توجد فواتير بلا تاريخ مثبت؛ لا يمكن ضمان اكتمال كميات الفترة.');
  if([...duplicateInvoices.values()].some(count=>count>1))issues.push('أرقام فواتير مكررة داخل الفرع؛ يلزم تصحيحها قبل اعتماد الفرق.');
  const sourceLastDate=transfers.reduce((last,row)=>row.transfer.date>last?row.transfer.date:last,'');
  const sourceFirstDate=transfers.reduce((first,row)=>!first||row.transfer.date<first?row.transfer.date:first,'');
  if(!transfers.length)issues.push('كشف ترحيلات SAP غير متاح.');
  else if(sourceLastDate<to)issues.push('آخر حركة في كشف SAP بتاريخ '+sourceLastDate+'؛ يلزم كشف يغطي الفحص حتى '+to+'.');
  if(sourceFirstDate>from)issues.push('كشف الترحيلات يبدأ بعد بداية الفترة '+from+'؛ تغطية الفترة غير مثبتة.');
  if(opening?.date===from)issues.push(...opening.issues);
  if(!closing)issues.push('رصيد 011 الفعلي المؤرخ غير متاح؛ افتح الملازم أول واحفظ كشف الرصيد.');
  else{
    issues.push(...closing.issues);
    if(closing.date!==to)issues.push('رصيد 011 المحفوظ بتاريخ '+closing.date+'، وتاريخ الفحص '+to+'؛ يلزم رصيد لنفس التاريخ.');
  }
  // Financial approval is independent of quantity evidence. Neither state
  // may silently stand in for the other in the summary.
  const financiallyUnapproved=new Set<string>();
  let paperGroups=0;
  let approvedGroups=0;
  const approvedTransfers=new Set<string>();
  let quantitiesComplete=true;
  const add=(code:string,name:string,quantity:number,record:ReassuranceRow['records'][number])=>{
    const total=totals.get(code)||{name,quantity:0,records:[]};
    total.quantity+=quantity;
    if(!total.records.some(row=>row.id===record.id))total.records.push(record);
    totals.set(code,total);
  };
  for(const record of data.records){
    const ids=selected.get(record.id);
    if(!ids?.size)continue;
    if(record.status!=='match')financiallyUnapproved.add(record.id);
    const draft=readReconciliationRecord(record.payload);
    if(!draft)continue;
    const invoices=draft.invoices.filter(invoice=>ids.has(invoice.id));
    const numbers=invoices.map(invoice=>invoice.number);
    if(invoices.some(invoice=>(duplicateInvoices.get(record.branch+'|'+invoice.number)||0)>1)){
      quantitiesComplete=false;pendingRecords.push({id:record.id,numbers,branch:record.branch,note:'رقم فاتورة مكرر؛ لم تُجمع كمياته مرتين.'});continue;
    }
    const reference=Array.isArray(draft.referenceSnapshot)&&draft.referenceSnapshot.length?draft.referenceSnapshot:data.reference;
    const savedLines=draft.transfers.flatMap(transfer=>parseTransfer(transfer.paste||'',{allowReverse:true}).lines);
    const savedCodes=new Set(savedLines.map(line=>line.sapCode));
    const paperRows=invoices.map(invoice=>({invoice,paper:paper(invoice)}));
    const staged:{code:string;name:string;quantity:number}[]=[];
    let reason='';
    if(paperRows.every(row=>row.paper.known)){
      for(const {invoice,paper:read} of paperRows)for(const [institutionCode,quantity] of read.values){
        const refs=sapReferences(reference).filter(item=>item.active&&item.code===institutionCode&&item.sapCode);
        const choices=refs.filter(item=>invoice.sapInstitutionChoices?.[item.sapCode]===institutionCode);
        const linked=refs.filter(item=>savedCodes.has(item.sapCode));
        const candidates=choices.length?choices:linked.length?linked:refs;
        const codes=[...new Set(candidates.map(item=>item.sapCode))];
        if(codes.length!==1){reason='ربط صنف المؤسسة '+institutionCode+' بكود SAP غير محسوم.';break;}
        staged.push({code:codes[0],name:candidates[0].name,quantity});
      }
      if(!reason)paperGroups++;
      if(!reason)for(const row of staged)add(row.code,row.name,row.quantity,{id:record.id,numbers,basis:'paper'});
    }else if(record.status==='match'&&invoices.length===draft.invoices.length&&
      invoices.every(invoice=>invoiceDocumentNo(invoice.number)&&invoice.complete)){
      // The saved group is the evidence, not today's SAP export. Comparing the
      // same live source with itself would conceal later cancellations/edits.
      const numbersInGroup=draft.transfers.flatMap(transfer=>transferNumbers(transfer.number||''));
      if(!numbersInGroup.length||numbersInGroup.some(number=>approvedTransfers.has(number))||
        new Set(numbersInGroup).size!==numbersInGroup.length)reason='ترحيل مكرر أو بلا رقم في الكميات المعتمدة للمجموعة.';
      for(const transfer of draft.transfers){
        const parsed=parseTransfer(transfer.paste||'',{allowReverse:true});
        if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length){reason='تفاصيل كميات الترحيل المحفوظ وقت الاعتماد غير مكتملة.';break;}
        for(const line of parsed.lines){
          const quantity=pieces(line.quantity,line.unit,line.sapCode,reference);
          if(quantity===null){reason='شدّة أو تحويل وحدة غير محسوم للصنف '+line.sapCode;break;}
          staged.push({code:line.sapCode,name:line.name,quantity:line.to==='011'?quantity:-quantity});
        }
      }
      if(!reason){
        approvedGroups++;
        numbersInGroup.forEach(number=>approvedTransfers.add(number));
        for(const row of staged)add(row.code,row.name,row.quantity,{id:record.id,numbers,basis:'approved'});
      }
    }else reason=record.status==='match'?'كميات المجموعة معتمدة؛ لا يمكن توزيعها على جزء من فواتيرها في هذه الفترة.':'تفاصيل كميات الفاتورة أو اعتمادها غير مكتمل.';
    if(reason){quantitiesComplete=false;pendingRecords.push({id:record.id,numbers,branch:record.branch,note:reason});}
  }
  if(!quantitiesComplete)issues.push('لم تكتمل كميات بعض الفواتير؛ لا يمكن تحديد مرتجع أو ترحيل نهائي.');
  const openingMap=new Map<string,StockItem>();
  for(const row of data.openingStock||[])if(row.snapshot_date===from&&row.warehouse==='011')
    openingMap.set(row.sap_code+'|'+row.unit,{code:row.sap_code,name:row.item_name,warehouse:'011',unit:row.unit,quantity:Number(row.quantity)});
  if(opening?.date===from)for(const row of opening.items)if(!openingMap.has(row.code+'|'+row.unit))openingMap.set(row.code+'|'+row.unit,row);
  const stock=auditLieutenantStock(closing?.items||[],[...openingMap.values()],transfers,new Set(),from,to,
    data.reference,undefined,completeOpeningSnapshot(opening,from));
  const byCode=new Map<string,typeof stock>();
  for(const row of stock)byCode.set(row.code,[...(byCode.get(row.code)||[]),row]);
  const evidence=new Map<string,ReassuranceEvidence[]>();
  for(const source of stockMovementSources(transfers)){
    if(source.transfer.date<from||source.transfer.date>to)continue;
    for(const line of source.transfer.paste.split('\n').slice(1)){
      if(!line.trim())continue;
      const [code,,rawQuantity,unit,fromWh,toWh]=line.split('\t');
      const quantity=signedNumeric(rawQuantity);
      if(!code||quantity===null)continue;
      evidence.set(code,[...(evidence.get(code)||[]),{number:source.transfer.number,date:source.transfer.date,
        direction:fromWh+' → '+toWh,quantity,unit,remarks:source.remarks}]);
    }
  }
  const globallyBlocked=issues.length>0;
  const rows:ReassuranceRow[]=[...new Set([...totals.keys(),...byCode.keys()])].sort().map(code=>{
    const entries=byCode.get(code)||[],total=totals.get(code);
    const notes=[...new Set(entries.flatMap(row=>row.issues))];
    const target=entries.length===1?entries[0]:undefined;
    if(entries.length>1)notes.push('الصنف مكرر بأكثر من وحدة في الرصيد؛ يلزم تأكيد الوحدة الأساسية.');
    const convert=(value:number|null|undefined)=>value===null||value===undefined||!target?null:pieces(value,target.unit,code,data.reference);
    const actual=convert(target?.quantity),start=convert(target?.opening),net=convert(target?.netTransfers);
    const stockDifference=convert(target?.difference);
    if(!target||actual===null)notes.push('رصيد الصنف أو تحويله إلى الحبة غير مثبت.');
    if(start===null)notes.push('افتتاحي الصنف غير مثبت في '+from+'.');
    if(target&&!target.movementComplete)notes.push('بيانات حركات الصنف غير مكتملة.');
    if(stockDifference!==null&&Math.abs(stockDifference)>epsilon)notes.push('فرق بين الرصيد الفعلي والافتتاحي وصافي الترحيلات؛ راجع حركات OINM قبل تحديد الإجراء.');
    const invoices=quantitiesComplete?round(total?.quantity||0):null;
    const expected=invoices===null||start===null?null:round(invoices+start);
    const sameDate=closing?.date===to;
    const difference=expected===null||actual===null||!sameDate?null:round(actual-expected);
    const blocked=globallyBlocked||notes.length>0||difference===null;
    const state:ReassuranceState=blocked?'review':Math.abs(difference!)<epsilon?'match':difference!<0?'transfer':'return';
    return {code,name:total?.name||target?.name||code,unit:'Piece',invoices,opening:start,expected,actual,difference,
      netTransfers:net,stockDifference,state,notes,records:total?.records||[],evidence:evidence.get(code)||[],candidates:[]};
  });
  const candidates=cancellationCandidates(rows,transfers,data.records,data.reference,from,to);
  for(const row of rows)row.candidates=candidates.get(row.code)||[];
  if(!rows.length)issues.push('لا توجد كميات كافية لإجراء المقارنة.');
  const state:ReassuranceState=issues.length||rows.some(row=>row.state==='review')?'review':
    rows.some(row=>row.state==='transfer')?'transfer':rows.some(row=>row.state==='return')?'return':'match';
  return {rows,issues:[...new Set(issues)],invoiceCount:collected.rows.filter(row=>invoiceDocumentNo(row.number)).length,
    approvedGroups,paperGroups,financialPending:financiallyUnapproved.size,pendingRecords,sourceLastDate,state};
}
