import {AQABA_START,AQABA_CUSTOMER} from './aqaba';
export function defaultAqabaDates(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const get=(key:string)=>parts.find(p=>p.type===key)?.value||'00';
 const today=get('year')+'-'+get('month')+'-'+get('day');
 const d=new Date(today+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);
 const from=d.toISOString().slice(0,10);
 return {from:from<AQABA_START?AQABA_START:from,to:today};
}
/** Query documents; never filter CANCELED='N' or discard reversal documents. */
export function officialAqabaQuery(from:string,to:string){
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to||from<AQABA_START)throw Error('فترة غير صحيحة');
 const source=[['IN','OINV','INV1'],['CN','ORIN','RIN1'],['DN','ODLN','DLN1'],['RE','ORDN','RDN1']];
 const select=(kind:string,head:string,lines:string)=>[
 'SELECT',
 "'"+kind+"' AS \"نوع المستند\",",
 'TO_NVARCHAR(H."DocNum") AS "رقم الفاتورة",',
 'TO_NVARCHAR(H."DocEntry") AS "DocEntry",',
 'TO_VARCHAR(H."DocDate", \'YYYY-MM-DD\') AS "التاريخ",',
 'H."CardCode" AS "رقم الزبون",',
 'H."CardName" AS "اسم الزبون",',
 'L."LineNum" + 1 AS "رقم السطر",',
 'L."WhsCode" AS "المستودع",',
 'L."ItemCode" AS "كود الصنف",',
 'L."Dscription" AS "اسم الصنف",',
 'L."unitMsr" AS "الوحدة",',
 'L."Quantity" AS "الكمية",',
 'L."Price" AS "سعر الوحدة",',
 'L."LineTotal" AS "القيمة قبل الضريبة",',
 'L."VatSum" AS "الضريبة",',
 'H."CANCELED" AS "حالة الإلغاء",',
 'TO_NVARCHAR(L."BaseType") AS "نوع المستند المرجعي",',
 'TO_NVARCHAR(L."BaseEntry") AS "BaseEntry",',
 'TO_NVARCHAR(L."BaseLine") AS "BaseLine",',
 'TO_NVARCHAR(L."BaseRef") AS "رقم المستند المرجعي"',
 'FROM "'+head+'" H',
 'INNER JOIN "'+lines+'" L ON H."DocEntry" = L."DocEntry"',
 "WHERE H.\"CardCode\" = '"+AQABA_CUSTOMER+"'",
 'AND L."WhsCode" = \'011\'',
 'AND L."ItemCode" IS NOT NULL',
 "AND H.\"DocDate\" BETWEEN TO_DATE('"+from+"', 'YYYY-MM-DD') AND TO_DATE('"+to+"', 'YYYY-MM-DD')"
 ].join('\n')
   .replaceAll('H."', '"'+head+'"."')
   .replaceAll('L."', '"'+lines+'"."')
   .replace('FROM "'+head+'" H', 'FROM "'+head+'"')
   .replace('INNER JOIN "'+lines+'" L', 'INNER JOIN "'+lines+'"');
 return source.map(s=>select(s[0],s[1],s[2])).join('\nUNION ALL\n')+'\nORDER BY "التاريخ", "رقم الفاتورة", "رقم السطر";';
}
export function transferAqabaQuery(from:string,to:string){
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to||from<AQABA_START)throw Error('فترة غير صحيحة');
 return [
 'SELECT TO_NVARCHAR("OWTR"."DocNum") AS "رقم الترحيل",',
 'TO_NVARCHAR("OWTR"."DocEntry") AS "DocEntry",',
 'TO_VARCHAR("OWTR"."DocDate", \'YYYY-MM-DD\') AS "التاريخ",',
 '"OWTR"."Comments" AS "Remarks",',
 '"OWTR"."CANCELED" AS "حالة الإلغاء",',
 '"WTR1"."LineNum" + 1 AS "رقم السطر",',
 '"WTR1"."ItemCode" AS "كود الصنف",',
 '"WTR1"."Dscription" AS "اسم الصنف",',
 '"WTR1"."unitMsr" AS "الوحدة",',
 '"WTR1"."Quantity" AS "الكمية",',
 '"WTR1"."FromWhsCod" AS "من المستودع",',
 '"WTR1"."WhsCode" AS "إلى المستودع"',
 'FROM "OWTR"',
 'INNER JOIN "WTR1" ON "OWTR"."DocEntry" = "WTR1"."DocEntry"',
 "WHERE (\"WTR1\".\"FromWhsCod\"='011' OR \"WTR1\".\"WhsCode\"='011')",
 "AND \"OWTR\".\"DocDate\" BETWEEN TO_DATE('"+from+"', 'YYYY-MM-DD') AND TO_DATE('"+to+"', 'YYYY-MM-DD')",
 'ORDER BY "OWTR"."DocDate", "OWTR"."DocNum", "WTR1"."LineNum";'
 ].join('\n');
}


/** Physical 011 movements for ALL customers and types. This is intentionally
 * not restricted to C0006751: 011 is shared, and transfers have no CardCode. */
export function aqabaInventoryQuery(from:string,to:string){
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to||from<AQABA_START)
  throw Error('فترة غير صحيحة');
 return [
 'SELECT TO_NVARCHAR("OINM"."TransNum") AS "معرف حركة المخزون",',
 'TO_VARCHAR("OINM"."DocDate", \'YYYY-MM-DD\') AS "التاريخ",',
 'TO_NVARCHAR("OINM"."TransType") AS "نوع حركة SAP",',
 'TO_NVARCHAR("OINM"."CreatedBy") AS "DocEntry",',
 'TO_NVARCHAR("OINM"."BASE_REF") AS "رقم المستند",',
 '"OINM"."DocLineNum" AS "رقم السطر",',
 '"OINM"."ItemCode" AS "كود الصنف",',
 '"OINM"."Dscription" AS "اسم الصنف",',
 '"OINM"."Warehouse" AS "المستودع",',
 '"OINM"."InQty" AS "الوارد",',
 '"OINM"."OutQty" AS "الصادر",',
 '"OINM"."CardCode" AS "رقم الزبون"',
 'FROM "OINM"',
 "WHERE \"OINM\".\"Warehouse\" = '011'",
 "AND \"OINM\".\"DocDate\" BETWEEN TO_DATE('"+from+"', 'YYYY-MM-DD') AND TO_DATE('"+to+"', 'YYYY-MM-DD')",
 'ORDER BY "OINM"."DocDate", "OINM"."TransNum", "OINM"."DocLineNum";'
 ].join('\n');
}
