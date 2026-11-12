import type {LieutenantTransfer} from './lieutenant';

export type LieutenantMovementKind =
  'normal'|'cashvan-pending'|'reversed'|'reverse'|'sap-canceled'|'sap-cancel-doc'|'cancellation-review';
export type LieutenantMovement = {
  kind:LieutenantMovementKind;
  counterpart?:string;
  counterparts?:string[];
  counterpartDate?:string;
  note:string;
};
const cashVan=/(?:كاش[\s._\-ـ]*[فڤ][اأإآ]ن|cash[\s._\-]*van)/iu;
const officialCancellation=/inventory\s+transfer\s+no\.?\s*(\d{4,20})\s+has\s+been\s+cancel(?:ed|led)/i;
const reverseReference=/(?:عكس(?:ي)?(?:\s+ترحيل)?|ترحيل\s+عكسي(?:\s+لترحيل)?|مقابل(?:\s+ترحيل)?|reverse(?:\s+(?:transfer|of))?|original(?:\s+transfer)?)\s*(?:رقم|no\.?|#|:|-)?\s*(\d{4,20})/iu;
export function isCashVanTransfer(source:LieutenantTransfer):boolean{
  return cashVan.test(source.remarks)||cashVan.test(source.branch);
}
function signature(source:LieutenantTransfer,flip=false,absolute=false):string{
  if(source.issues.length)return '';
  const parts=source.transfer.paste.replace(/\r/g,'').split('\n').slice(1).map(line=>{
    const [code,,rawQty,rawUnit,from,to]=line.split('\t');
    const qty=Number((rawQty||'').replace(/,/g,''));
    if(!code||!rawUnit||!from||!to||!Number.isFinite(qty)||qty<0&&!absolute)return '';
    return [code.toUpperCase(),(absolute?Math.abs(qty):qty).toFixed(6),rawUnit.toLowerCase(),flip?to:from,flip?from:to].join('|');
  });
  return !parts.length||parts.some(part=>!part)?'':parts.sort().join('||');
}
function compare(incoming:LieutenantTransfer,outgoing:LieutenantTransfer):boolean{
  if(incoming.reverse||!outgoing.reverse)return false;
  if(incoming.branch&&outgoing.branch&&incoming.branch!==outgoing.branch)return false;
  if(!incoming.transfer.date||!outgoing.transfer.date||outgoing.transfer.date<incoming.transfer.date)return false;
  const original=signature(incoming);
  return !!original&&original===signature(outgoing,true);
}
/** A bundle of partial reverse documents is valid only if every SAP code,
 * quantity, UoM and warehouse direction balances. Never reuse a reverse.
 * An unreferenced reverse must belong to exactly one candidate original.
 */
function amounts(source:LieutenantTransfer,flip=false):Map<string,number>|null{
  if(source.issues.length||source.signedAdjustment)return null;
  const values=new Map<string,number>();
  for(const text of source.transfer.paste.replace(/\r/g,'').split('\n').slice(1)){
    if(!text.trim())continue;
    const [rawCode,,rawQuantity,rawUnit,rawFrom,rawTo]=text.split('\t');
    const quantity=Number((rawQuantity||'').replace(/,/g,''));
    if(!rawCode||!rawUnit||!rawFrom||!rawTo||!Number.isFinite(quantity)||quantity<=0)return null;
    const key=[rawCode.toUpperCase(),rawUnit.toLowerCase(),
      flip?rawTo:rawFrom,flip?rawFrom:rawTo].join('|');
    values.set(key,(values.get(key)||0)+quantity);
  }
  return values.size?values:null;
}
function canPartiallyReverse(original:LieutenantTransfer,reverse:LieutenantTransfer):boolean{
  if(original.reverse||!reverse.reverse||original.transfer.number===reverse.transfer.number||
    original.branch&&reverse.branch&&original.branch!==reverse.branch||
    !original.transfer.date||!reverse.transfer.date||reverse.transfer.date<original.transfer.date)return false;
  const incoming=amounts(original),outgoing=amounts(reverse,true);
  return !!incoming&&!!outgoing&&[...outgoing].every(([key,qty])=>
    incoming.has(key)&&qty<=incoming.get(key)!+0.000001);
}
function fullyBalanced(original:LieutenantTransfer,reverses:LieutenantTransfer[]):boolean{
  const incoming=amounts(original);
  if(!incoming||!reverses.length)return false;
  const total=new Map<string,number>();
  for(const reverse of reverses){
    if(!canPartiallyReverse(original,reverse))return false;
    for(const [key,quantity] of amounts(reverse,true)!)
      total.set(key,(total.get(key)||0)+quantity);
  }
  return incoming.size===total.size&&[...incoming].every(([key,quantity])=>
    Math.abs(quantity-(total.get(key)||0))<0.000001);
}
const active=(source:LieutenantTransfer)=>
  source.cancellationState!=='canceled'&&source.cancellationState!=='cancellation'&&
  !source.signedAdjustment&&!officialCancellation.test(source.remarks);

export function analyzeLieutenantMovements(
  transfers:LieutenantTransfer[],periodEnd:string,
):Map<string,LieutenantMovement>{
  const byNumber=new Map(transfers.map(source=>[source.transfer.number,source]));
  const resolved=new Map<string,LieutenantMovement>();
  const pairs=new Map<string,string>();
  const usedReverse=new Set<string>();
  const ambiguousReferences=new Set<string>();

  // Official SAP cancellation documents are not ordinary outbound transfers.
  // Match by explicit document number and, if both are available, all opposite line signatures.
  for(const cancellation of transfers){
    const state=cancellation.cancellationState;
    const reference=cancellation.remarks.match(officialCancellation)?.[1];
    if(state!=='cancellation'&&!reference)continue;
    const original=reference?byNumber.get(reference):undefined;
    const confirmed=state==='cancellation'&&original&&compare(original,cancellation);
    const note=confirmed?'مستند إلغاء SAP مطابق لكل بنود الترحيل الأصلي':
      'مستند/ملاحظة إلغاء: يلزم إثبات رقم الأصل وتطابق السطور وحالة SAP';
    resolved.set(cancellation.transfer.number,{
      kind:confirmed?'sap-cancel-doc':'cancellation-review',
      counterpart:reference, note,
    });
    if(confirmed&&original){
      resolved.set(original.transfer.number,{
        kind:'sap-canceled',counterpart:cancellation.transfer.number,
        counterpartDate:cancellation.transfer.date,
        note:'ترحيل ملغى على SAP بمستند إلغاء رقم '+cancellation.transfer.number,
      });
    }
  }

  // CANCELED=Y is direct SAP evidence, whether or not the cancellation document is in this file.
  for(const source of transfers){
    if(source.cancellationState==='canceled')
      resolved.set(source.transfer.number,{kind:'sap-canceled',note:'حالة SAP: ملغى (Y)'});
  }

  // The shared SAP query represents correction documents as signed quantities
  // in the original direction. Their stock effect is valid; a negative sign
  // and Remarks do not, on their own, prove CANCELED=Y/C in SAP.
  for(const correction of transfers){
    if(!correction.signedAdjustment||correction.cancellationState==='canceled'||correction.cancellationState==='cancellation')continue;
    const originalNo=correction.remarks.match(officialCancellation)?.[1];
    const original=originalNo?byNumber.get(originalNo):undefined;
    const allNegative=correction.transfer.paste.split('\n').slice(1)
      .every(line=>Number((line.split('\t')[2]||'').replace(/,/g,''))<0);
    const matches=original&&allNegative&&!original.signedAdjustment&&
      (!original.branch||!correction.branch||original.branch===correction.branch)&&
      original.transfer.date<=correction.transfer.date&&!!signature(original)&&
      signature(original)===signature(correction,false,true);
    resolved.set(correction.transfer.number,{kind:'cancellation-review',counterpart:originalNo,
      note:'حركة تصحيح سالبة؛ يُحتسب أثرها الموقّع في المخزون، وتحتاج حالة الإلغاء للتحقق على SAP. لا تحتاج فاتورة زرقاء مستقلة.'});
    if(matches&&original&&!resolved.has(original.transfer.number)&&correction.transfer.date<=periodEnd)
      resolved.set(original.transfer.number,{kind:'cancellation-review',counterpart:correction.transfer.number,
        note:'يقابله تصحيح سالب مطابق بالكامل رقم '+correction.transfer.number+
          ' بتاريخ '+correction.transfer.date+'؛ تحقّق من حالة الإلغاء على SAP قبل طلب فاتورة له.'});
  }

  // First honor an explicitly referenced reverse, but only when all original
  // items, quantities, UoMs, and source/destination warehouses match exactly.
  for(const reverse of transfers){
    if(!reverse.reverse||!active(reverse)||resolved.has(reverse.transfer.number))continue;
    const originalNo=reverse.remarks.match(reverseReference)?.[1];
    if(!originalNo)continue;
    const original=byNumber.get(originalNo);
    if(!original||!active(original)||resolved.has(originalNo)||!compare(original,reverse))continue;
    if(ambiguousReferences.has(originalNo))continue;
    if(pairs.has(originalNo)){
      ambiguousReferences.add(originalNo);
      usedReverse.delete(pairs.get(originalNo)!);
      pairs.delete(originalNo);
      continue;
    }
    pairs.set(originalNo,reverse.transfer.number);
    usedReverse.add(reverse.transfer.number);
  }

  // Without a reference, pair only unique, exact full-document inverses.
  // Same item/quantity in several branches/documents is ambiguous; never guess.
  const candidates=new Map<string,string[]>();
  const reverseCandidates=new Map<string,string[]>();
  for(const reverse of transfers){
    if(!reverse.reverse||!active(reverse)||resolved.has(reverse.transfer.number)||usedReverse.has(reverse.transfer.number))continue;
    for(const original of transfers){
      if(original.reverse||!active(original)||resolved.has(original.transfer.number)||pairs.has(original.transfer.number)||ambiguousReferences.has(original.transfer.number))continue;
      if(!compare(original,reverse))continue;
      const ids=candidates.get(original.transfer.number)||[];
      ids.push(reverse.transfer.number);
      candidates.set(original.transfer.number,ids);
      const forwards=reverseCandidates.get(reverse.transfer.number)||[];
      forwards.push(original.transfer.number);
      reverseCandidates.set(reverse.transfer.number,forwards);
    }
  }
  for(const [original,ids] of candidates){
    if(ids.length!==1||reverseCandidates.get(ids[0])?.length!==1||usedReverse.has(ids[0]))continue;
    pairs.set(original,ids[0]);
    usedReverse.add(ids[0]);
  }

  // Some Cash Van movements are reversed with two or more separate SAP
  // documents. Require an exact aggregate, unique provenance and no reused IDs.
  const bundles=new Map<string,string[]>();
  for(const original of transfers){
    const originalNo=original.transfer.number;
    if(!isCashVanTransfer(original)||original.reverse||!active(original)||
      resolved.has(originalNo)||pairs.has(originalNo))continue;
    const compatible=transfers.filter(reverse=>{
      if(!reverse.reverse||!active(reverse)||resolved.has(reverse.transfer.number)||
        usedReverse.has(reverse.transfer.number)||!canPartiallyReverse(original,reverse))return false;
      const ref=reverse.remarks.match(reverseReference)?.[1];
      if(ref)return ref===originalNo;
      // Without an explicit reference, all quantities/warehouses must point
      // uniquely to this original; otherwise this is only a possible reverse.
      const originals=transfers.filter(other=>!other.reverse&&active(other)&&
        !resolved.has(other.transfer.number)&&!pairs.has(other.transfer.number)&&
        canPartiallyReverse(other,reverse));
      return originals.length===1&&originals[0].transfer.number===originalNo;
    });
    if(compatible.length<2||!fullyBalanced(original,compatible))continue;
    const ids=compatible.map(reverse=>reverse.transfer.number);
    bundles.set(originalNo,ids);
    ids.forEach(number=>usedReverse.add(number));
  }

  for(const [originalNo,reverseNos] of [
    ...[...pairs].map(([number,reverseNo]):[string,string[]]=>[number,[reverseNo]]),
    ...bundles,
  ]){
    const original=byNumber.get(originalNo)!;
    const reverses=reverseNos.map(number=>byNumber.get(number)!);
    const latestDate=reverses.map(row=>row.transfer.date).sort().at(-1)!;
    const later=latestDate>periodEnd;
    const cash=isCashVanTransfer(original);
    const numbers=reverseNos.join('، ');
    resolved.set(originalNo,{
      kind:later?(cash?'cashvan-pending':'normal'):'reversed',
      counterpart:reverseNos[0],counterparts:reverseNos,counterpartDate:latestDate,
      note:later?
        'يوجد عكسي مطابق بالكامل برقم '+numbers+'، لكن آخر عكسي بتاريخ '+latestDate+
        ' خارج الفترة المحددة؛ لم تُغلق الحركة بعد.':
        (cash?'كاش فان — عكسي مطابق بالكامل برقم '+numbers+'؛ مجموع الأصناف والكميات والاتجاهات متساوٍ، وصافي الحركة صفر (ليس إلغاء SAP).':
          'عكسي مطابق بالكامل برقم '+numbers+'، صافي الحركة صفر (ليس إلغاء SAP).'),
    });
    for(const reverseNo of reverseNos)
      resolved.set(reverseNo,{
        kind:'reverse',counterpart:originalNo,counterpartDate:original.transfer.date,
        note:'ترحيل عكسي مقابل '+originalNo+'؛ لا يحتاج فاتورة زرقاء مستقلة.',
      });
  }

  // A referenced partial reversal is not a full settlement. Display its
  // actual number for follow-up without incorrectly declaring the stock zero.
  for(const original of transfers){
    const number=original.transfer.number;
    if(!isCashVanTransfer(original)||original.reverse||!active(original)||resolved.has(number))continue;
    const partial=transfers.filter(reverse=>reverse.reverse&&active(reverse)&&
      !usedReverse.has(reverse.transfer.number)&&
      reverse.remarks.match(reverseReference)?.[1]===number&&
      canPartiallyReverse(original,reverse));
    if(!partial.length)continue;
    const ids=partial.map(row=>row.transfer.number);
    resolved.set(number,{
      kind:'cashvan-pending',counterpart:ids[0],counterparts:ids,
      note:'كاش فان — وُجد عكسي مرتبط رقم '+ids.join('، ')+
        '، لكن لم يثبت أنه يغطي كامل الأصناف والكميات؛ لا تُعتبر الحركة مسوّاة بعد.',
    });
  }
  for(const source of transfers){
    const number=source.transfer.number;
    if(resolved.has(number))continue;
    if(source.reverse){
      resolved.set(number,{kind:'reverse',
        note:'صادر من 011؛ ليس ترحيل وارد يستلزم فاتورة زرقاء. افحص ارتباطه بالعكسي.'});
    }else if(isCashVanTransfer(source)){
      resolved.set(number,{kind:'cashvan-pending',
        note:'كاش فان — لم يثبت عكسي مطابق بالكامل أو إلغاء SAP؛ مراجعة عكسي/إلغاء، وليس فاتورة زرقاء.'});
    }else{
      resolved.set(number,{kind:'normal',note:''});
    }
  }
  return resolved;
}
