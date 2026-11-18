import {collectInvoicesByDate} from './invoice-collector';
import {buildColonelReport,type ColonelRecord,type ColonelAssignment,type ColonelDayState} from './colonel-core';
import {analyzeLieutenantMovements,isCashVanTransfer} from './lieutenant-counterparts';
import type {CancellationDecision} from './lieutenant-cancellation-decisions';
import type {LieutenantTransfer} from './lieutenant';
import {invoiceDocumentNo,readReconciliationRecord,transferNumbers} from './reconcile';

export type ReassuranceCouncilControl={
  days:ColonelDayState[];assignments:ColonelAssignment[];decisions:CancellationDecision[];
  signoffs?:{day:string;fingerprint:string;source_key:string;signed_at:string}[];
};
export type ReassuranceCouncilFinding={
  source:'soldier'|'lieutenant'|'colonel';
  title:string;details:string;recordId?:string;transferNo?:string;day?:string;
};
export type ReassuranceCouncilReport={
  soldier:{invoices:number;paperPending:number;duplicates:number;unlinked:number;inferredDates:number;unreadable:number;
    /** Saja workbook is uploaded in the soldier's browser; no persistent source can prove receipt here. */
    sajaAvailable:false};
  lieutenant:{transfers:number;reversed:number;canceled:number;cashVanPending:number;review:number;savedDecisions:number};
  colonel:{invoiceDays:number;readyDays:number;openTransfers:number;unassigned:number;warnings:number};
  findings:ReassuranceCouncilFinding[];
};

const distinct=<T>(values:T[])=>[...new Set(values)];
const monthsBetween=(from:string,to:string)=>{
  const items:string[]=[];
  let cursor=from.slice(0,7),end=to.slice(0,7);
  for(let count=0;cursor<=end&&count<14;count++){
    items.push(cursor);
    const date=new Date(cursor+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);
    cursor=date.toISOString().slice(0,7);
  }
  if(cursor<=end)throw Error('الفترة أطول من الحد المقبول لمراجعة العقيد.');
  return items;
};

/** A read-only, sourced cross-check. No Saja workbook is fabricated from the
 * project registry, and administrative signoffs NEVER become stock evidence. */
export function buildReassuranceCouncil(input:{
  from:string;to:string;records:ColonelRecord[];transfers:LieutenantTransfer[];
  controls:ReassuranceCouncilControl[];sourceReady:boolean;
}):ReassuranceCouncilReport{
  const {from,to,records,transfers,controls,sourceReady}=input;
  const findings:ReassuranceCouncilFinding[]=[];
  const uniqueFindings=new Set<string>();
  const push=(row:ReassuranceCouncilFinding)=>{
    const key=[row.source,row.title,row.recordId,row.transferNo,row.day].join('|');
    if(uniqueFindings.has(key))return;
    uniqueFindings.add(key);findings.push(row);
  };
  const collected=collectInvoicesByDate(records,from,to);
  const byRecord=new Map(records.map(record=>[record.id,readReconciliationRecord(record.payload)]));
  const invoiceOwners=new Map<string,Set<string>>();
  let paperPending=0,duplicates=0,unlinked=0;
  for(const record of records){
    const draft=byRecord.get(record.id);
    if(!draft)continue;
    for(const invoice of draft.invoices){
      const number=invoiceDocumentNo(invoice.number||'');
      if(!number)continue;
      invoiceOwners.set(number,new Set([...(invoiceOwners.get(number)||[]),record.id+'|'+invoice.id]));
    }
  }
  for(const row of collected.rows){
    const number=invoiceDocumentNo(row.number);
    const draft=byRecord.get(row.recordId);
    const invoice=draft?.invoices.find(item=>item.id===row.invoiceId);
    if(!invoice||!number||invoice.complete!==true){
      paperPending++;
      push({source:'soldier',title:'فاتورة غير مؤكدة أو رقمها غير صالح',
        details:'الفاتورة '+(number||row.number||'بلا رقم')+' — يلزم تأكيد الورق ورقم الفاتورة داخل الجندي.',
        recordId:row.recordId});
    }
    if(number&&(invoiceOwners.get(number)?.size||0)>1){
      duplicates++;
      push({source:'soldier',title:'رقم فاتورة مكرر',
        details:'الفاتورة '+number+' موجودة في أكثر من سجل؛ لا يجوز جمع كمياتها مرتين.',
        recordId:row.recordId});
    }
    if(row.unresolvedTransferNumbers.length){
      unlinked++;
      push({source:'soldier',title:'ربط ترحيل بفواتير متعددة غير محسوم',
        details:'الفاتورة '+(number||row.number)+' — الترحيلات غير المحسومة: '+row.unresolvedTransferNumbers.join('، '),
        recordId:row.recordId});
    }
    if(row.dateSource==='transfer')
      push({source:'soldier',title:'تاريخ الفاتورة مشتق من الترحيل',
        details:'الفاتورة '+(number||row.number)+' — يلزم تأكيد التاريخ من الورق.',
        recordId:row.recordId});
  }
  const soldier={
    invoices:collected.rows.filter(row=>!!invoiceDocumentNo(row.number)).length,
    paperPending,duplicates,unlinked,inferredDates:collected.inferredDates,
    unreadable:collected.unreadableRecords,
    sajaAvailable:false as const,
  };
  if(collected.unreadableRecords)
    push({source:'soldier',title:'سجلات فواتير غير قابلة للقراءة',
      details:collected.unreadableRecords+' سجل يحتاج إصلاحًا؛ لا يمكن اعتباره فارغًا.'});
  if(collected.undatedInvoices)
    push({source:'soldier',title:'فواتير بلا تاريخ مثبت',
      details:collected.undatedInvoices+' فاتورة غير مؤرخة لا يمكن نسبتها تلقائيًا إلى الفترة.'});

  const combinedDays=distinct(controls.flatMap(item=>item.days).map(item=>item.day))
    .map(day=>controls.flatMap(item=>item.days).find(row=>row.day===day)!);
  const assignments=distinct(controls.flatMap(item=>item.assignments).map(item=>item.transfer_no))
    .map(number=>controls.flatMap(item=>item.assignments).find(row=>row.transfer_no===number)!);
  const decisions=distinct(controls.flatMap(item=>item.decisions).map(item=>item.transfer_no))
    .map(number=>controls.flatMap(item=>item.decisions).find(row=>row.transfer_no===number)!);

  const movements=analyzeLieutenantMovements(transfers,to);
  const within=transfers.filter(row=>row.transfer.date>=from&&row.transfer.date<=to);
  let reversed=0,canceled=0,cashVanPending=0,review=0;
  for(const source of within){
    const status=movements.get(source.transfer.number);
    if(status?.kind==='reversed'||status?.verifiedOffset&&source.signedAdjustment!==true)reversed++;
    if(status?.kind==='sap-canceled'&&!source.reverse)canceled++;
    if(isCashVanTransfer(source)&&status?.kind==='cashvan-pending'&&!source.reverse){
      cashVanPending++;
      push({source:'lieutenant',title:'كاش فان دون تسوية مثبتة',
        details:'ترحيل '+source.transfer.number+' — '+(status.note||'العكسي أو إلغاء SAP غير مثبت.'),
        transferNo:source.transfer.number});
    }
    if(source.issues.length||status?.kind==='cancellation-review'&&!status.verifiedOffset&&!status.documentedCancellation){
      review++;
      push({source:'lieutenant',title:'مستند SAP يحتاج إثباتًا',
        details:'ترحيل '+source.transfer.number+' — '+[...source.issues,status?.note||''].filter(Boolean).join('؛ '),
        transferNo:source.transfer.number});
    }
  }
  const lieutenant={transfers:within.length,reversed,canceled,cashVanPending,review,savedDecisions:decisions.length};

  const allColonel=monthsBetween(from,to).map(month=>buildColonelReport(
    month,records,transfers,decisions,assignments,combinedDays,sourceReady));
  const activeDays=allColonel.flatMap(month=>month.days).filter(day=>day.day>=from&&day.day<=to&&
    (day.invoices.length>0||day.invoicesComplete));
  let readyDays=0;
  for(const day of activeDays){
    if(day.ready){readyDays++;continue;}
    push({source:'colonel',title:'يوم فواتير غير مغلق بالفحص',
      details:day.day+' — '+day.reason,day:day.day});
  }
  const byTransfer=new Map<string,ReturnType<typeof buildColonelReport>['unassigned'][number]>();
  for(const report of allColonel)
    for(const line of [...report.days.flatMap(day=>day.transfers),...report.unassigned]){
      if(!line.needsAction)continue;
      const belongsToPeriod=line.postingDate>=from&&line.postingDate<=to||
        line.invoiceDay>=from&&line.invoiceDay<=to;
      if(!belongsToPeriod)continue;
      if(!byTransfer.has(line.number))byTransfer.set(line.number,line);
    }
  for(const transfer of byTransfer.values())push({source:'colonel',
    title:'العقيد بحاجة حسم ترحيل',
    details:'ترحيل '+transfer.number+' — '+(transfer.note||'ارتباط الفاتورة أو تسوية SAP غير محسوم.'),
    transferNo:transfer.number});
  const unassigned=[...byTransfer.values()].filter(row=>!row.invoiceDay).length;
  const warnings=distinct(allColonel.flatMap(report=>report.warnings));
  if(warnings.length)push({source:'colonel',title:'تحذيرات رقابة شهرية',
    details:warnings.length+' تنبيه، منها: '+warnings.slice(0,3).join('؛ ')});
  const colonel={invoiceDays:activeDays.length,readyDays,openTransfers:byTransfer.size,
    unassigned,warnings:warnings.length};
  return {soldier,lieutenant,colonel,findings};
}
