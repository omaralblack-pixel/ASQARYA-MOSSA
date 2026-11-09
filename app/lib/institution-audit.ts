import {convert, fils, numeric, parseTransfer, sapReferences, type Item, type Transfer} from './reconcile';

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


/** Compare institutional invoice rows in pieces against the net SAP movement. */
export type QuantityAuditRow={
  code:string; institutionName:string; sapCodes:string[];
  sapPieces:number; invoicePieces:number; difference:number; price:number|null;
};
export type QuantityAudit={
  status:'missing-invoice'|'review'|'difference'|'match';
  rows:QuantityAuditRow[]; issues:string[]; invoiceTotal:number|null;
  expectedTotal:number|null; amountDifference:number|null;
};
/** Requires two tab-separated columns: institution item number and quantity in pieces. */
export function auditInvoiceQuantities(
  transfers:Transfer[], reference:Item[], invoiceText:string, invoiceAmount=''
):QuantityAudit {
  const issues:string[]=[];
  const active=reference.filter(item=>item.active);
  const byCode=new Map(active.map(item=>[item.code,item]));
  const bySap=new Map(sapReferences(active).map(item=>[item.sapCode.toUpperCase(),item]));
  const sapPieces=new Map<string,number>();
  const invoicePieces=new Map<string,number>();
  const sapCodes=new Map<string,Set<string>>();
  const paperLines=invoiceText.trim().replace(/\r/g,'').split('\n').filter(Boolean);
  for(const line of paperLines){
    const parts=line.split('\t').map(v=>v.trim());
    const code=parts[0]?.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).trim();
    if(!/^\d{8}$/.test(code)){
      if(/رقم|item|code/i.test(line))continue;
      issues.push('سطر الفاتورة غير صالح: '+line.slice(0,100));continue;
    }
    const quantity=numeric(parts[1]);
    if(quantity===null||quantity<0||!Number.isFinite(quantity)){
      issues.push('كمية فاتورة غير صحيحة للمادة '+code);continue;
    }
    if(!byCode.has(code))issues.push('رقم المادة '+code+' في الفاتورة غير معرّف بالمؤسسة.');
    invoicePieces.set(code,(invoicePieces.get(code)||0)+quantity);
  }
  for(const transfer of transfers){
    const parsed=parseTransfer(transfer.paste,{allowReverse:true});
    for(const line of parsed.lines){
      const item=bySap.get(line.sapCode.toUpperCase());
      if(!item)continue; // separate scope audit always reports unknown SAP items
      try {
        const converted=convert(line,item);
        sapPieces.set(item.code,(sapPieces.get(item.code)||0)+converted);
        const codes=sapCodes.get(item.code)||new Set<string>();
        codes.add(line.sapCode);sapCodes.set(item.code,codes);
      }catch(e){
        issues.push('تعذّر تحويل '+line.sapCode+' في الترحيل '+transfer.number+': '+(e instanceof Error?e.message:String(e)));
      }
    }
  }
  const allCodes=[...new Set([...sapPieces.keys(),...invoicePieces.keys()])].sort();
  const rows=allCodes.map(code=>{
    const item=byCode.get(code);
    const sap=Number((sapPieces.get(code)||0).toFixed(6));
    const paper=Number((invoicePieces.get(code)||0).toFixed(6));
    return {code,institutionName:item?.name||'مادة غير معرّفة',
      sapCodes:[...(sapCodes.get(code)||[])],sapPieces:sap,invoicePieces:paper,
      difference:Number((paper-sap).toFixed(6)),price:item?.price??null};
  });
  if(!paperLines.length)return {status:'missing-invoice',rows,issues,invoiceTotal:null,expectedTotal:null,amountDifference:null};
  const invoiceTotal=invoiceAmount.trim()?fils(invoiceAmount):null;
  if(invoiceAmount.trim()&&invoiceTotal===null)issues.push('مبلغ الفاتورة غير صالح؛ أدخله حتى ثلاث منازل عشرية.');
  const expectedTotal=rows.length&&rows.every(row=>row.price!==null)
    ?rows.reduce((total,row)=>total+Math.round(row.sapPieces*row.price!),0):null;
  const amountDifference=invoiceTotal===null||expectedTotal===null?null:invoiceTotal-expectedTotal;
  const status=issues.length?'review':rows.some(row=>Math.abs(row.difference)>0.000001)||
    (amountDifference!==null&&amountDifference!==0)?'difference':'match';
  return {status,rows,issues,invoiceTotal,expectedTotal,amountDifference};
}
