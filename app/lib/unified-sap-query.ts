/** One SAP HANA export containing tagged, non-destructive evidence for warehouse 011.
 * Dates are SAP posting dates. Prior movements are retained for the opening
 * snapshot; canceled/reversal lines are never filtered out.
 */
const fields = [
  'RecordType','DocumentType','DocumentNumber','DocEntry','DocumentDate',
  'LineNumber','ItemCode','ItemName','Unit','Quantity','FromWarehouse',
  'ToWarehouse','Warehouse','InQty','OutQty','StockQuantity','TransNum',
  'TransType','CardCode','CardName','CancellationStatus','Remarks',
  'JournalRemarks','Price','LineTotal','VatSum','BaseType','BaseEntry',
  'BaseLine','BaseRef',
] as const;
type Field = typeof fields[number];
type Expressions = Partial<Record<Field,string>>;
const dateOk=(value:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const day=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(day)&&new Date(day).toISOString().slice(0,10)===value;
};
const nz=(value:string)=>'TO_NVARCHAR('+value+')';
const day=(value:string)=>'TO_VARCHAR('+value+", 'YYYY-MM-DD')";
const select=(values:Expressions,source:string,where:string)=>
  'SELECT\n'+fields.map(field=>'  '+(values[field]||"''")+' AS "'+field+'"').join(',\n')+
  '\n'+source+(where?'\n'+where:'');
const wh011='\'011\'';
export function unifiedSapQuery(from:string,to:string):string{
  if(!dateOk(from)||!dateOk(to)||from>to)throw Error('تاريخ البداية والنهاية غير صالحين.');
  const first="TO_DATE('"+from+"', 'YYYY-MM-DD')";
  const last="TO_DATE('"+to+"', 'YYYY-MM-DD')";
  const transfer=select({
    RecordType:"'TRANSFER'",DocumentNumber:nz('H."DocNum"'),
    DocEntry:nz('H."DocEntry"'),DocumentDate:day('H."DocDate"'),
    LineNumber:nz('L."LineNum" + 1'),ItemCode:'L."ItemCode"',
    ItemName:'L."Dscription"',Unit:'L."unitMsr"',
    Quantity:nz('L."Quantity"'),FromWarehouse:'L."FromWhsCod"',
    ToWarehouse:'L."WhsCode"',CancellationStatus:'H."CANCELED"',
    Remarks:'H."Comments"',JournalRemarks:'H."JrnlMemo"',
  },'FROM "OWTR" H INNER JOIN "WTR1" L ON H."DocEntry" = L."DocEntry"',
  'WHERE (L."FromWhsCod" = '+wh011+' OR L."WhsCode" = '+wh011+
  ') AND H."DocDate" BETWEEN '+first+' AND '+last);
  const stock=(kind:'OPENING'|'CLOSING')=>select({
    RecordType:kind==='OPENING'?"'OPENING'":"'CLOSING'",
    DocumentDate:kind==='OPENING'?"'"+from+"'":"'"+to+"'",
    ItemCode:'M."ItemCode"',ItemName:'I."ItemName"',
    Unit:'I."InvntryUom"',Warehouse:"'011'",
    StockQuantity:nz('SUM(M."InQty" - M."OutQty")'),
  },'FROM "OINM" M LEFT JOIN "OITM" I ON M."ItemCode" = I."ItemCode"',
  'WHERE M."Warehouse" = '+wh011+' AND M."DocDate" '+
  (kind==='OPENING'?'< '+first:'<= '+last)+
  '\nGROUP BY M."ItemCode", I."ItemName", I."InvntryUom"');
  const journal=select({
    RecordType:"'OINM'",DocumentNumber:nz('M."BASE_REF"'),
    DocEntry:nz('M."CreatedBy"'),DocumentDate:day('M."DocDate"'),
    LineNumber:nz('M."DocLineNum"'),ItemCode:'M."ItemCode"',
    ItemName:'M."Dscription"',Warehouse:'M."Warehouse"',
    InQty:nz('M."InQty"'),OutQty:nz('M."OutQty"'),
    TransNum:nz('M."TransNum"'),TransType:nz('M."TransType"'),
    CardCode:'M."CardCode"',BaseRef:nz('M."BASE_REF"'),
  },'FROM "OINM" M',
  'WHERE M."Warehouse" = '+wh011+' AND M."DocDate" BETWEEN '+first+' AND '+last);
  const official=([
    ['IN','OINV','INV1'],['CN','ORIN','RIN1'],
    ['DN','ODLN','DLN1'],['RE','ORDN','RDN1'],
  ] as const).map(([kind,header,line])=>select({
    RecordType:"'OFFICIAL'",DocumentType:"'"+kind+"'",
    DocumentNumber:nz('H."DocNum"'),DocEntry:nz('H."DocEntry"'),
    DocumentDate:day('H."DocDate"'),LineNumber:nz('L."LineNum" + 1'),
    ItemCode:'L."ItemCode"',ItemName:'L."Dscription"',
    Unit:'L."unitMsr"',Quantity:nz('L."Quantity"'),
    Warehouse:'L."WhsCode"',CardCode:'H."CardCode"',
    CardName:'H."CardName"',CancellationStatus:'H."CANCELED"',
    Price:nz('L."Price"'),LineTotal:nz('L."LineTotal"'),
    VatSum:nz('L."VatSum"'),BaseType:nz('L."BaseType"'),
    BaseEntry:nz('L."BaseEntry"'),BaseLine:nz('L."BaseLine"'),
    BaseRef:nz('L."BaseRef"'),
  },'FROM "'+header+'" H INNER JOIN "'+line+'" L ON H."DocEntry" = L."DocEntry"',
  'WHERE H."CardCode" = \''+'C0006751'+'\' AND L."WhsCode" = '+wh011+
  ' AND H."DocDate" BETWEEN '+first+' AND '+last));
  return '-- SAP Business One HANA | Complete 011 evidence | '+from+' through '+to+
    '\n-- One TSV/Excel export; do not filter canceled or reverse documents.\n'+
    [select({RecordType:"'WINDOW'",DocumentDate:"'"+from+"'",BaseRef:"'"+to+"'"},'FROM DUMMY',''),transfer,stock('OPENING'),stock('CLOSING'),journal,...official].join('\nUNION ALL\n')+
    '\nORDER BY "RecordType", "DocumentDate", "DocumentNumber", "LineNumber";';
}

const transferHeaders=[
  ['Document Number','DocumentNumber'],['Document Date','DocumentDate'],
  ['Item No.','ItemCode'],['Item Description','ItemName'],
  ['Quantity','Quantity'],['UoM Code','Unit'],
  ['From Warehouse','FromWarehouse'],['To Warehouse','ToWarehouse'],
  ['Remarks','Remarks'],['Journal Remarks','JournalRemarks'],
  ['CANCELED','CancellationStatus'],
] as const;
const stockHeaders=[
  ['رقم الصنف','ItemCode'],['اسم الصنف','ItemName'],
  ['المستودع','Warehouse'],['وحدة المخزون','Unit'],
] as const;
const officialHeaders=[
  ['نوع المستند','DocumentType'],['رقم الفاتورة','DocumentNumber'],
  ['DocEntry','DocEntry'],['التاريخ','DocumentDate'],
  ['رقم الزبون','CardCode'],['اسم الزبون','CardName'],
  ['رقم السطر','LineNumber'],['المستودع','Warehouse'],
  ['كود الصنف','ItemCode'],['اسم الصنف','ItemName'],
  ['الوحدة','Unit'],['الكمية','Quantity'],['سعر الوحدة','Price'],
  ['القيمة قبل الضريبة','LineTotal'],['الضريبة','VatSum'],
  ['حالة الإلغاء','CancellationStatus'],['نوع المستند المرجعي','BaseType'],
  ['BaseEntry','BaseEntry'],['BaseLine','BaseLine'],
  ['رقم المستند المرجعي','BaseRef'],
] as const;
const journalHeaders=[
  ['معرف حركة المخزون','TransNum'],['التاريخ','DocumentDate'],
  ['نوع حركة SAP','TransType'],['DocEntry','DocEntry'],
  ['رقم المستند','DocumentNumber'],['رقم السطر','LineNumber'],
  ['كود الصنف','ItemCode'],['اسم الصنف','ItemName'],
  ['المستودع','Warehouse'],['الوارد','InQty'],
  ['الصادر','OutQty'],['رقم الزبون','CardCode'],
] as const;
export type UnifiedSapSections={
  transfers:string;opening:string;closing:string;official:string;journal:string;
  from:string;to:string;counts:Record<string,number>;
};
export function isUnifiedSapSource(text:string):boolean{
  const first=text.replace(/^\uFEFF/,'').split(/\r?\n/).find(Boolean)||'';
  const headers=first.split('\t');
  return ['RecordType','DocumentNumber','DocumentDate','ItemCode','StockQuantity']
    .every(key=>headers.includes(key));
}
export function splitUnifiedSapSource(text:string):UnifiedSapSections{
  if(!isUnifiedSapSource(text))throw Error('الملف لا يحتوي أعمدة الكويري الشامل المطلوبة.');
  const lines=text.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n').filter(Boolean);
  const header=lines[0].split('\t');
  if(new Set(header).size!==header.length)throw Error('كشف SAP الشامل يحتوي أعمدة مكررة.');
  const missing=fields.filter(col=>!header.includes(col));
  if(missing.length)throw Error('كشف SAP الشامل ناقص أعمدة: '+missing.join('، '));
  const positions=Object.fromEntries(header.map((key,index)=>[key,index]));
  const groups:Record<string,string[][]>={WINDOW:[],TRANSFER:[],OPENING:[],CLOSING:[],OFFICIAL:[],OINM:[]};
  let from='',to='';
  for(let i=1;i<lines.length;i++){
    const parts=lines[i].split('\t');
    if(parts.length!==header.length)throw Error('السطر '+(i+1)+': عدد الأعمدة مختلف؛ لم تُعالَج البيانات منعًا لفقدان بنود.');
    const kind=parts[positions.RecordType];
    if(!Object.prototype.hasOwnProperty.call(groups,kind))
      throw Error('السطر '+(i+1)+': نوع سجل SAP غير معروف: '+kind);
    const date=parts[positions.DocumentDate];
    if((kind==='OPENING'||kind==='CLOSING')&&!dateOk(date))
      throw Error('السطر '+(i+1)+': تاريخ الرصيد غير صحيح.');
    if(kind==='OPENING'){if(from&&from!==date)throw Error('كشف الافتتاحي يحتوي تواريخ مختلفة.');from=date}
    if(kind==='CLOSING'){if(to&&to!==date)throw Error('كشف الختامي يحتوي تواريخ مختلفة.');to=date}
    groups[kind].push(parts);
  }
  const window=groups.WINDOW;
  if(window.length!==1)throw Error('بيانات بداية ونهاية فترة الكويري ناقصة أو مكررة.');
  const expectedFrom=window[0][positions.DocumentDate],expectedTo=window[0][positions.BaseRef];
  if(!dateOk(expectedFrom)||!dateOk(expectedTo)||expectedFrom>expectedTo)throw Error('فترة الكويري غير صالحة.');
  if(from&&from!==expectedFrom||to&&to!==expectedTo)throw Error('تواريخ الأرصدة لا تطابق فترة الكويري.');
  from=expectedFrom;to=expectedTo;
  const asTsv=(mapping:readonly (readonly [string,string])[],rows:string[][])=>
    [mapping.map(([key])=>key).join('\t'),
      ...rows.map(cells=>mapping.map(([,key])=>(cells[positions[key]]||'').replace(/[\t\r\n]+/g,' ')).join('\t'))]
    .join('\n');
  return {
    transfers:asTsv(transferHeaders,groups.TRANSFER),
    opening:asTsv([...stockHeaders,['الرصيد الافتتاحي','StockQuantity'] as const],groups.OPENING),
    closing:asTsv([...stockHeaders,['الرصيد الفعلي بنهاية التاريخ','StockQuantity'] as const],groups.CLOSING),
    official:asTsv(officialHeaders,groups.OFFICIAL),
    journal:asTsv(journalHeaders,groups.OINM),
    from,to,
    counts:Object.fromEntries(Object.entries(groups).map(([key,rows])=>[key,rows.length])),
  };
}
