import type {LieutenantTransfer} from './lieutenant';

export type LieutenantMovementKind =
  'normal'|'cashvan-pending'|'reversed'|'reverse'|'sap-canceled'|'sap-cancel-doc'|'cancellation-review';
export type LieutenantMovement = {
  kind:LieutenantMovementKind;
  counterpart?:string;
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

  for(const [originalNo,reverseNo] of pairs){
    const original=byNumber.get(originalNo)!;
    const reverse=byNumber.get(reverseNo)!;
    const later=reverse.transfer.date>periodEnd;
    const cash=isCashVanTransfer(original);
    resolved.set(originalNo,{
      kind:later?(cash?'cashvan-pending':'normal'):'reversed',
      counterpart:reverseNo,counterpartDate:reverse.transfer.date,
      note:later?
        'يوجد عكسي مطابق رقم '+reverseNo+' بتاريخ '+reverse.transfer.date+'، لكنه خارج الفترة المحددة؛ لم تُغلق الحركة بعد.':
        (cash?'كاش فان — عكسي مطابق بالكامل رقم '+reverseNo+'، صافي الحركة صفر (ليس إلغاء SAP).':
          'عكسي مطابق بالكامل رقم '+reverseNo+'، صافي الحركة صفر (ليس إلغاء SAP).'),
    });
    resolved.set(reverseNo,{
      kind:'reverse',counterpart:originalNo,counterpartDate:original.transfer.date,
      note:'ترحيل عكسي مقابل '+originalNo+'؛ لا يحتاج فاتورة زرقاء مستقلة.',
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
