import {AQABA_START,AQABA_CUSTOMER} from './aqaba';
export function defaultAqabaDates(now=new Date()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
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
 'TO_VARCHAR(H."DocDate", ''YYYY-MM-DD'') AS "التاريخ",'.replace("''YYYY-MM-DD''","'YYYY-MM-DD'"),
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
 ].join('\n');
 return source.map(s=>select(s[0],s[1],s[2])).join('\nUNION ALL\n')+'\nORDER BY "التاريخ", "رقم الفاتورة", "رقم السطر";';
}
export function transferAqabaQuery(from:string,to:string){
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to||from<AQABA_START)throw Error('فترة غير صحيحة');
 return [
 'SELECT TO_NVARCHAR(H."DocNum") AS "رقم الترحيل",',
 'TO_NVARCHAR(H."DocEntry") AS "DocEntry",',
 'TO_VARCHAR(H."DocDate", \'YYYY-MM-DD\') AS "التاريخ",',
 'H."Comments" AS "Remarks",',
 'H."CANCELED" AS "حالة الإلغاء",',
 'L."LineNum" + 1 AS "رقم السطر",',
 'L."ItemCode" AS "كود الصنف",',
 'L."Dscription" AS "اسم الصنف",',
 'L."unitMsr" AS "الوحدة",',
 'L."Quantity" AS "الكمية",',
 'L."FromWhsCod" AS "من المستودع",',
 'L."WhsCode" AS "إلى المستودع"',
 'FROM "OWTR" H',
 'INNER JOIN "WTR1" L ON H."DocEntry"=L."DocEntry"',
 "WHERE (L.\"FromWhsCod\"='011' OR L.\"WhsCode\"='011')",
 "AND H.\"DocDate\" BETWEEN TO_DATE('"+from+"', 'YYYY-MM-DD') AND TO_DATE('"+to+"', 'YYYY-MM-DD')",
 'ORDER BY H."DocDate", H."DocNum", L."LineNum";'
 ].join('\n');
}
