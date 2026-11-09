import {convert, parseTransfer, sapReferences, type Item, type Transfer} from './reconcile';

/**
 * Independent, read-only SAP scope audit.
 * Does not use or change Draft.excludedItems, the manual reconciliation
 * result, SAP movements, or the existing invoice approval workflow.
 */
export type AuditIssue = {
  kind: 'foreign' | 'conversion' | 'source';
  code: string;
  name: string;
  unit?: string;
  origin?: string;
  transferred?: number;
  reversed?: number;
  remaining?: number;
  transferNumbers: string[];
  message: string;
};
export type AuditResolution = {
  code: string;
  name: string;
  unit: string;
  origin: string;
  quantity: number;
  transferNumbers: string[];
};
export type InstitutionAudit = {
  issues: AuditIssue[];
  resolved: AuditResolution[];
  approvedLines: number;
  reviewedLines: number;
  valid: boolean;
};

type ForeignMovement = {
  code: string;
  name: string;
  unit: string;
  origin: string;
  transferred: number;
  reversed: number;
  numbers: Set<string>;
};
const close = (a:number, b:number) => Math.abs(a-b) < 0.000001;
const fmt = (n:number) => Number(n.toFixed(6)).toLocaleString('en-US',{maximumFractionDigits:6});

/** Only a reversal with the exact same SAP code, UoM and source warehouse can clear an unknown movement. */
export function auditInstitutionTransfers(transfers: Transfer[], reference: Item[]): InstitutionAudit {
  const bySap = new Map(sapReferences(reference.filter(item => item.active)).map(item => [item.sapCode.toUpperCase(), item]));
  const foreign = new Map<string, ForeignMovement>();
  const issues:AuditIssue[] = [], resolved:AuditResolution[] = [];
  let approvedLines = 0, reviewedLines = 0;
  if (!transfers.length) issues.push({kind:'source',code:'',name:'',transferNumbers:[],message:'لا توجد ترحيلات لفحصها.'});

  for (const transfer of transfers) {
    const number = transfer.number || 'بدون رقم';
    const parsed = parseTransfer(transfer.paste || '', {allowReverse:true});
    for (const message of [...parsed.issues, ...parsed.excluded]) {
      issues.push({kind:'source',code:'',name:'',transferNumbers:[number],message:'الترحيل '+number+': '+message});
    }
    if (!parsed.lines.length) {
      issues.push({kind:'source',code:'',name:'',transferNumbers:[number],message:'الترحيل '+number+': لا توجد بنود SAP صالحة للفحص.'});
    }
    for (const line of parsed.lines) {
      reviewedLines++;
      const found = bySap.get(line.sapCode.toUpperCase());
      if (found) {
        try {
          const converted = convert(line, found);
          if (!Number.isFinite(converted)) throw Error('التحويل إلى الحبة غير صالح');
          approvedLines++;
        } catch(e) {
          issues.push({kind:'conversion', code:line.sapCode, name:found.name,unit:line.unit,
            transferNumbers:[number],
            message:'الترحيل '+number+': '+line.sapCode+' — '+(e instanceof Error ? e.message : 'تعذّر تحويل الوحدة إلى حبات')+'.'});
        }
        continue;
      }
      // Unknown SKU: never guess a carton or KG conversion ratio.
      // Movement can only be reversed in the SAME SAP unit and original warehouse.
      const reversing = line.from === '011';
      const origin = reversing ? line.to : line.from;
      const key = [line.sapCode.toUpperCase(), line.unit, origin].join('|');
      const item = foreign.get(key) || {
        code:line.sapCode.toUpperCase(), name:line.name || line.sapCode,
        unit:line.unit, origin, transferred:0, reversed:0, numbers:new Set<string>()
      };
      item.numbers.add(number);
      if (reversing) item.reversed += Math.abs(line.quantity);
      else item.transferred += line.quantity;
      foreign.set(key,item);
    }
  }
  for (const item of foreign.values()) {
    const transferNumbers=[...item.numbers];
    const remaining=Number((item.transferred-item.reversed).toFixed(6));
    if (item.transferred>0 && close(item.transferred,item.reversed)) {
      resolved.push({code:item.code,name:item.name,unit:item.unit,origin:item.origin,
        quantity:item.transferred,transferNumbers});
    } else {
      const mismatch=item.reversed>item.transferred ? 'الترحيل العكسي أكبر من الحركة الأصلية أو لا يقابلها.' :
        item.reversed>0 ? 'العكس جزئي؛ ما زالت هناك كمية غير معكوسة.' : 'لم يُربط ترحيل عكسي مطابق.';
      issues.push({kind:'foreign', code:item.code,name:item.name,unit:item.unit,origin:item.origin,
        transferred:item.transferred,reversed:item.reversed,remaining,transferNumbers,
        message:'يوجد صنف ما إله دخل في المؤسسة، الرجاء مراجعة الترحيل. '+
          item.code+' · '+item.name+' · من المستودع '+item.origin+
          ' · محوّل '+fmt(item.transferred)+' '+item.unit+
          ' · عكسي '+fmt(item.reversed)+' '+item.unit+'. '+mismatch});
    }
  }
  return {issues,resolved,approvedLines,reviewedLines,valid:issues.length===0};
}
