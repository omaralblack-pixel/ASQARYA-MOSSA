import {convert,dateValue,fils,invoiceDocumentNo,pageNumber,parseTransfer,reconcile,sapReferences,
 soldierLineKey,transferNumbers,type Draft,type Item} from './reconcile';

type Row={key:string;sapCode:string;institutionCode:string;pieces:number;price:number;value:number;transfer:string};
export type FinancialPageSort={method:'historical-financial';signature:string;createdAt:string;
  invoiceValues:number[];lineCount:number;source:'amount-allocated-not-paper-verified'};
export type FinancialDraft=Draft&{financialPageSort?:FinancialPageSort;
  summary?:{status?:string;acceptedDifference?:boolean}};
export type FinancialPlan={
  state:'ready'|'skip';reason:string;draft?:FinancialDraft;invoiceCount:number;
  lineCount:number;estimated:boolean;
};
export type FinancialRecord={id:string;branch:string;version:number;payload:string};
export type FinancialPreview={ready:Array<{id:string;version:number;branch:string;invoices:string[];lines:number;estimated:boolean}>;
  skipped:Array<{id:string;branch:string;reason:string}>;scanned:number};

const EPS=1e-6;
const close=(a:number,b:number)=>Math.abs(a-b)<EPS;
const sum=(values:number[])=>values.reduce((s,v)=>s+v,0);
const total=(d:Draft)=>d.invoices.map(inv=>fils(inv.amount));
const sorted=(xs:Row[])=>[...xs].sort((a,b)=>b.value-a.value||a.sapCode.localeCompare(b.sapCode)||a.key.localeCompare(b.key));
const hash=(source:string)=>{
  let a=2166136261,b=2246822519;
  for(let i=0;i<source.length;i++){
    const ch=source.charCodeAt(i);
    a=Math.imul(a^ch,16777619);b=Math.imul(b^ch,3266489917);
  }
  return (a>>>0).toString(16)+'-'+(b>>>0).toString(16)+'-'+source.length;
};
const signature=(d:Draft)=>hash(JSON.stringify([
  d.invoices.map(inv=>[inv.id,invoiceDocumentNo(inv.number),inv.amount,inv.complete]),
  d.transfers.map(t=>[t.id,t.number,t.paste]),
  d.referenceSnapshot?.map(x=>[x.code,x.sapCode,x.price,x.cartonPieces,x.kgPerPiece,x.active,x.sapAliases])||[],
  d.excludedItems||{},
]));

function readLines(d:Draft):{rows:Row[];reason:string}{
  if(!d.referenceSnapshot?.length)return {rows:[],reason:'لا يوجد مرجع الأسعار والشدّات المحفوظ وقت المطابقة.'};
  const reference=new Map(sapReferences(d.referenceSnapshot.filter(x=>x.active)).map(item=>[item.sapCode.toUpperCase(),item]));
  const rows:Row[]=[];
  const keys=new Set<string>();
  for(const transfer of d.transfers){
    const numbers=transferNumbers(transfer.number||'');
    if(numbers.length!==1||!/^\d{4,20}$/.test(numbers[0]))
      return {rows:[],reason:'رقم ترحيل مركّب أو غير صالح؛ يحتاج مراجعة.'};
    const parsed=parseTransfer(transfer.paste||'',{allowReverse:true});
    if(parsed.issues.length||parsed.excluded.length||!parsed.lines.length)
      return {rows:[],reason:'في الترحيل سطور ناقصة أو خارج مسارات المؤسسة؛ لا يجوز توزيعها بالتخمين.'};
    for(const line of parsed.lines){
      if(line.quantity<=0)return {rows:[],reason:'يوجد عكسي أو كمية صفرية؛ يحتاج توزيعًا معتمدًا.'};
      const item=reference.get(line.sapCode.toUpperCase());
      if(!item||!Number.isInteger(item.price)||item.price===null||item.price<=0)
        return {rows:[],reason:'في الترحيل صنف غير معرّف أو سعر الحبة غير مكتمل.'};
      let pieces:number;
      try{pieces=convert(line,item)}catch{return {rows:[],reason:'شدّة أو وزن أحد الأصناف غير معرّف.'}}
      if(!Number.isSafeInteger(pieces)||pieces<=0||pieces>1000000)
        return {rows:[],reason:'كمية صنف لا تتحول إلى عدد صحيح وآمن من الحبات.'};
      const key=soldierLineKey(transfer.id,line);
      if(keys.has(key))return {rows:[],reason:'تكرار مُعرّف سطر ترحيل في السجل.'};
      keys.add(key);
      const value=pieces*item.price;
      if(!Number.isSafeInteger(value)||value<=0)
        return {rows:[],reason:'قيمة صنف غير صالحة.'};
      rows.push({key,sapCode:line.sapCode.toUpperCase(),institutionCode:item.code,pieces,
        price:item.price,value,transfer:numbers[0]});
    }
  }
  return {rows,reason:rows.length?'':'لا توجد بنود ترحيل صالحة.'};
}

function allocateWhole(rows:Row[],amounts:number[],hints:Map<string,number>){
  const balances=[...amounts],allocations:Record<string,Record<string,number>>={};
  const ordered=sorted(rows);
  const failed=new Set<string>();
  let steps=0,tooComplex=false;
  const suffix=Array(ordered.length+1).fill(0);
  for(let i=ordered.length-1;i>=0;i--)suffix[i]=suffix[i+1]+ordered[i].value;
  const visit=(index:number):boolean=>{
    if(++steps>130000){tooComplex=true;return false}
    if(index===ordered.length)return balances.every(n=>n===0);
    if(sum(balances)!==suffix[index])return false;
    const state=index+'|'+balances.join(',');
    if(failed.has(state))return false;
    const row=ordered[index];
    const preferred=hints.get(row.sapCode);
    const possible=balances.map((remaining,i)=>({page:i+1,remaining}))
      .filter(x=>x.remaining>=row.value)
      .sort((a,b)=>Number(b.page===preferred)-Number(a.page===preferred)||
        b.remaining-a.remaining||a.page-b.page);
    for(const {page} of possible){
      balances[page-1]-=row.value;
      allocations[row.key]={[String(page)]:row.pieces};
      if(visit(index+1))return true;
      balances[page-1]+=row.value;delete allocations[row.key];
      if(tooComplex)break;
    }
    failed.add(state);
    return false;
  };
  return visit(0)?allocations:null;
}

/** Two-page exact financial partition, with piece-level splitting when whole-row sorting fails.
 * State limit is intentional: unresolved records remain unchanged rather than blocking the site.
 */
function allocateTwoWithSplits(rows:Row[],amounts:number[],hints:Map<string,number>){
  if(rows.length>65)return null;
  const target=amounts[0];
  type Node={prev:Node|null;qty:number;index:number};
  let states=new Map<number,Node|null>([[0,null]]);
  const ordered=sorted(rows);
  for(let index=0;index<ordered.length;index++){
    const row=ordered[index],next=new Map<number,Node>();
    const preferred=hints.get(row.sapCode);
    const partialCap=Math.min(row.pieces,500);
    const choices=preferred===1?[row.pieces,0]:[0,row.pieces];
    if(row.pieces<=partialCap)for(let n=1;n<row.pieces;n++)choices.push(n);
    for(const [existing,prev] of states){
      for(const qty of choices){
        const value=existing+qty*row.price;
        if(value>target||next.has(value))continue;
        next.set(value,{prev,qty,index});
      }
      if(next.size>100000)return null;
    }
    states=next;
    if(!states.size)return null;
  }
  const solved=states.get(target);
  if(!solved)return null;
  const allocation:Record<string,Record<string,number>>={};
  let node:Node|null=solved;
  for(let i=ordered.length-1;i>=0;i--){
    if(!node||node.index!==i)return null;
    const row=ordered[i];
    const inFirst=node.qty,inSecond=row.pieces-inFirst;
    allocation[row.key]={...inFirst?{'1':inFirst}:{},...inSecond?{'2':inSecond}:{}};
    node=node.prev;
  }
  return allocation;
}

function financiallyExact(d:Draft,reference:Item[],sourceRows:Row[],allocations:Record<string,Record<string,number>>){
  const amounts=total(d);
  if(amounts.some(value=>value===null))return false;
  const values=d.invoices.map(()=>0);
  for(const row of sourceRows){
    const parts=allocations[row.key];
    if(!parts||!Object.keys(parts).length||Object.entries(parts).some(([page,qty])=>
      !/^\d+$/.test(page)||Number(page)<1||Number(page)>d.invoices.length||
      !Number.isInteger(qty)||qty<=0)||sum(Object.values(parts))!==row.pieces)return false;
    for(const [page,qty] of Object.entries(parts))values[Number(page)-1]+=qty*row.price;
  }
  return values.every((value,i)=>Number.isSafeInteger(value)&&value===amounts[i]);
}

/** Check a previously saved calculated distribution before any downstream export or re-save. */
export function isVerifiedFinancialSort(d:FinancialDraft){
  if(d.financialPageSort?.method!=='historical-financial')return false;
  if(d.financialPageSort.signature!==signature(d))return false;
  const parsed=readLines(d);
  return !parsed.reason&&financiallyExact(d,d.referenceSnapshot||[],parsed.rows,d.soldierLineAllocations||{});
}

/** Learn a tie-breaking preference from already numbered, manually sorted saved groups.
 * Hints never override financial equality and cannot change historical records.
 */
export function learnHistoricalPageHints(records:FinancialRecord[]){
  const votes=new Map<string,Map<number,number>>();
  for(const record of records){
    let d:FinancialDraft;
    try{d=JSON.parse(record.payload) as FinancialDraft}catch{continue}
    if(!Array.isArray(d?.invoices)||d.invoices.length<2||d.financialPageSort||!d.referenceSnapshot?.length)continue;
    const bySap=new Map(sapReferences(d.referenceSnapshot).map(x=>[x.sapCode.toUpperCase(),x.code]));
    for(const transfer of d.transfers||[])for(const line of parseTransfer(transfer.paste||'',{allowReverse:true}).lines){
      const key=soldierLineKey(transfer.id,line);
      const manual=d.soldierManualLineKeys?.includes(key);
      const parts=manual?d.soldierLineAllocations?.[key]:undefined;
      const pages=parts&&Object.keys(parts).length===1?Object.keys(parts)[0]:
        d.pages?.['i:'+(bySap.get(line.sapCode)||'')]||d.pages?.['s:'+line.sapCode];
      const page=pageNumber(pages);
      if(page<1||page>d.invoices.length)continue;
      const group=record.branch+'|'+d.invoices.length+'|'+line.sapCode;
      const tally=votes.get(group)||new Map<number,number>();
      tally.set(page,(tally.get(page)||0)+1);votes.set(group,tally);
    }
  }
  return votes;
}

export function proposeHistoricalFinancialSort(d:FinancialDraft,branch:string,
  learned:Map<string,Map<number,number>>=new Map()):FinancialPlan{
  const skip=(reason:string):FinancialPlan=>({state:'skip',reason,invoiceCount:d.invoices?.length||0,lineCount:0,estimated:false});
  if(!Array.isArray(d.invoices)||d.invoices.length<2||d.invoices.length>4)
    return skip('يعمل على السجلات غير الموزعة التي فيها من فاتورتين إلى أربع فواتير.');
  if(!Array.isArray(d.transfers)||!d.transfers.length)return skip('لا توجد ترحيلات مرتبطة.');
  if(d.financialPageSort)return skip('هذا الكشف سبق ترتيبه ماليًا.');
  if(Object.keys(d.soldierLineAllocations||{}).length||d.soldierManualLineKeys?.length)
    return skip('يوجد توزيع محفوظ؛ لن يُستبدل ترتيبك السابق.');
  if(Object.values(d.pages||{}).some(value=>pageNumber(value)>0))
    return skip('يوجد ترقيم يدوي للصفحات؛ لن يُستبدل.');
  if(d.invoices.some(inv=>!inv.complete||!invoiceDocumentNo(inv.number)))
    return skip('الورق غير مؤكد أو رقم فاتورة ناقص.');
  const amounts=total(d);
  if(amounts.some(n=>n===null||n<=0))return skip('مبلغ فاتورة ناقص أو صفر أو غير صالح.');
  const {rows,reason}=readLines(d);
  if(reason)return skip(reason);
  if(rows.length>70)return skip('عدد أسطر SAP كبير جدًا للتوزيع الآلي الآمن.');
  if(sum(amounts as number[])!==sum(rows.map(row=>row.value)))
    return skip('إجمالي قيمة SAP لا يساوي مجموع مبالغ الفواتير.');
  if(Object.keys(d.excludedItems||{}).length)
    return skip('يوجد استبعاد يدوي لأصناف؛ لا يجوز إعادة توزيعها تلقائيًا.');
  const audit=reconcile(d,d.referenceSnapshot||[]);
  if(audit.status!=='match'||audit.priceDifference!==0)
    return skip('المطابقة المالية الأصلية غير مكتملة أو فيها فرق غير محسوم.');
  const savedApproved=d.summary?.status==='match'||Object.keys(d.checks||{}).length>0;
  if(!savedApproved)return skip('لا يوجد اعتماد محفوظ أو تشييك يدوي للصنف.');
  const hints=new Map<string,number>();
  for(const row of rows){
    const votes=learned.get(branch+'|'+d.invoices.length+'|'+row.sapCode);
    if(!votes)continue;
    const winning=[...votes].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0];
    if(winning)hints.set(row.sapCode,winning[0]);
  }
  const amountsRequired=amounts as number[];
  const allocations=allocateWhole(rows,amountsRequired,hints)||
    (d.invoices.length===2?allocateTwoWithSplits(rows,amountsRequired,hints):null);
  if(!allocations)return skip('لا يوجد توزيع مالي دقيق للحبات على مبالغ الصفحات، أو عدد الاحتمالات كبير.');
  if(!financiallyExact(d,d.referenceSnapshot||[],rows,allocations))
    return skip('فشل تحقق إعادة الجمع المالي لكل فاتورة.');
  const pages={...d.pages},totals:Record<string,number>={};
  const codes=new Map<string,Set<string>>();
  for(const row of rows){
    totals[row.key]=row.pieces;
    const pagesForCode=codes.get(row.institutionCode)||new Set<string>();
    Object.keys(allocations[row.key]).forEach(page=>pagesForCode.add(page));
    codes.set(row.institutionCode,pagesForCode);
  }
  for(const [code,parts] of codes){
    if(parts.size===1)pages['i:'+code]=[...parts][0];
    else delete pages['i:'+code];
  }
  const next:FinancialDraft={...d,pages,soldierLineAllocations:allocations,soldierLineTotals:totals,
    soldierManualLineKeys:d.soldierManualLineKeys||[],
    financialPageSort:{method:'historical-financial',signature:signature(d),createdAt:new Date().toISOString(),
      invoiceValues:amountsRequired,lineCount:rows.length,source:'amount-allocated-not-paper-verified'}};
  return {state:'ready',reason:'موزع ماليًا، وليس إثباتًا أن أصناف الورق على نفس الصفحة.',
    draft:next,invoiceCount:d.invoices.length,lineCount:rows.length,estimated:true};
}

export function previewHistoricalFinancialSort(records:FinancialRecord[],fromInput:string,toInput:string):FinancialPreview{
  const from=dateValue(fromInput),to=dateValue(toInput);
  if(!from||!to||from>to)throw Error('فترة الفواتير غير صالحة.');
  const days=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
  if(days>366)throw Error('أقصى مدة للتنظيم سنة واحدة.');
  const learned=learnHistoricalPageHints(records);
  const ready:FinancialPreview['ready']=[],skipped:FinancialPreview['skipped']=[];
  let scanned=0;
  for(const record of records){
    let draft:FinancialDraft;
    try{draft=JSON.parse(record.payload) as FinancialDraft}catch{continue}
    if(!Array.isArray(draft?.invoices)||!draft.invoices.some(inv=>{
      const date=dateValue(inv?.date||'');return date!==null&&date>=from&&date<=to;
    }))continue;
    scanned++;
    const plan=proposeHistoricalFinancialSort(draft,record.branch,learned);
    if(plan.state==='ready')ready.push({id:record.id,version:record.version,branch:record.branch,
      invoices:draft.invoices.map(inv=>invoiceDocumentNo(inv.number)),lines:plan.lineCount,estimated:true});
    else skipped.push({id:record.id,branch:record.branch,reason:plan.reason});
  }
  return {ready,skipped,scanned};
}
