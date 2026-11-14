/** Aqaba is a separate SAP customer sharing warehouse 011 with Amman.
 * Never infer a physical stock movement from an invoice row: only OINM proves it.
 */
export const AQABA_CUSTOMER='C0006751';
export const AQABA_START='2026-11-01';
export type AqabaDocumentKind='IN'|'CN'|'DN'|'RE';
export type AqabaLine={
 key:string;kind:AqabaDocumentKind;document:string;docEntry:string;date:string;
 customer:string;warehouse:string;row:number;item:string;description:string;
 unit:string;quantity:number;unitPrice:number;lineTotal:number;tax:number;
 canceled:string;baseType:string;baseEntry:string;baseLine:string;baseRef:string;
 inventoryEffect:'unverified'; 
};
export type BlueLine={
 key:string;invoice:string;date:string;item:string;description:string;
 quantity:number;unit:string;price:number;officialNumbers:string[];transferNumbers:string[];
 sourceFile?:string;sourceEstimatedPack?:number;
};
export type ReadResult<T>={items:T[];issues:string[]};
const digits=(s:string)=>s.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632))
 .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776));
const norm=(s:string)=>digits(s||'').toLowerCase().replace(/[\s._\-:،()]+/g,'').trim();
const field=(cols:string[],aliases:string[])=>cols.findIndex(c=>aliases.some(a=>norm(c)===norm(a)));
const number=(s:string):number|null=>{
 const value=digits((s||'').replace(/\bJOD\b/gi,'').replace(/[٬,]/g,'').trim());
 if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))return null;
 const n=Number(value);return Number.isFinite(n)?n:null;
};
const date=(s:string)=>{const v=digits(s||'').trim();
 const m=v.match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
 if(m)return m[3]+'-'+m[2]+'-'+m[1];
 return /^\d{4}-\d{2}-\d{2}$/.test(v)?v:'';
};
const codes=(s:string)=>[...new Set(digits(s||'').split(/[,\s،+؛;]+/).map(s=>s.trim()).filter(s=>/^\d{4,20}$/.test(s)))];
export const normalizeAqabaUnit=(s:string)=>{
 const n=norm(s);
 if(['piece','pieces','حبة','حبات','pcs'].includes(n))return 'Piece';
 if(['carton','cartons','كرتون','كرتونة','ctn'].includes(n))return 'Carton';
 if(['kg','كيلو','كغم','kilogram'].includes(n))return 'KG';
 return s.trim();
};
function table(source:string){const rows=source.replace(/^\uFEFF/,'').replace(/\r/g,'')
 .split('\n').filter(x=>x.trim()).map(x=>x.split('\t').map(s=>s.trim()));
 return {rows,header:rows[0]||[]};
}
export function readAqabaOfficial(source:string):ReadResult<AqabaLine>{
 const {rows,header}=table(source),issues:string[]=[],items:AqabaLine[]=[];
 if(!rows.length)return {items,issues:['ألصق كشف SAP مع صف العناوين.']};
 const names={
 kind:['نوع المستند','نوع الحركة','document type'],doc:['رقم الفاتورة','رقم المستند','document','docnum'],
 entry:['docentry','المعرف الداخلي','رقم المستند الداخلي'],date:['التاريخ','posting date','date'],
 customer:['رقم الزبون','cardcode','customer code'],row:['رقم السطر','doc. row','line number'],
 warehouse:['المستودع','whse','warehouse','whscode'],item:['كود الصنف','item no.','itemcode'],
 description:['اسم الصنف','item description','description'],unit:['الوحدة','inventory uom','uom'],
 qty:['الكمية','qty','quantity'],price:['سعر الوحدة','price after disc.','unit price'],
 total:['القيمة قبل الضريبة','line total','linetotal'],tax:['الضريبة','vat','vatsum'],
 canceled:['حالة الإلغاء','canceled','cancelled'],baseType:['نوع المستند المرجعي','basetype'],
 baseEntry:['baseentry','رقم المرجع الداخلي'],baseLine:['baseline','سطر المرجع'],
 baseRef:['رقم المستند المرجعي','baseref','details'],
 } as const;
 const ix=Object.fromEntries(Object.entries(names).map(([k,v])=>[k,field(header,[...v])]));
 if(['kind','doc','date','customer','row','warehouse','item','qty','price'].some(k=>ix[k]<0))
   return {items,issues:['كشف SAP ناقص أعمدة إلزامية: نوع المستند، رقم المستند، التاريخ، الزبون، السطر، المستودع، الصنف، الكمية، السعر.']};
 const read=(cells:string[],key:string)=>ix[key]>=0?(cells[ix[key]]||'').trim():'';
 const found=new Map<string,string>();
 for(let n=1;n<rows.length;n++){
  const cells=rows[n],kind=read(cells,'kind').toUpperCase() as AqabaDocumentKind,
    customer=read(cells,'customer'),warehouse=read(cells,'warehouse').padStart(3,'0'),
    document=digits(read(cells,'doc')),docEntry=digits(read(cells,'entry')),
    lineNo=number(read(cells,'row')),item=read(cells,'item').toUpperCase(),
    qty=number(read(cells,'qty')),price=number(read(cells,'price')),day=date(read(cells,'date'));
  if(customer!==AQABA_CUSTOMER){issues.push('السطر '+(n+1)+': زبون غير العقبة؛ لم يُستورد.');continue}
  if(warehouse!=='011'){issues.push('السطر '+(n+1)+': مستودع خارج 011؛ لم يُستورد.');continue}
  if(!(['IN','CN','DN','RE'] as string[]).includes(kind)||!document||!day||
     !Number.isInteger(lineNo)||lineNo!<1||!/^[A-Z]{2,6}\d{3,10}$/.test(item)||
     qty===null||qty<0||price===null){
   issues.push('السطر '+(n+1)+': بيانات مستند غير مكتملة أو غير صالحة.');continue;
  }
  if(day<AQABA_START){issues.push('السطر '+(n+1)+': مستند قبل بداية نظام العقبة، لم يُستورد تلقائيًا.');continue}
  const status=(read(cells,'canceled')||'غير موضح').toUpperCase();
  if(!['N','Y','C','غير موضح'].includes(status)){
    issues.push('السطر '+(n+1)+': حالة إلغاء غير معروفة.');continue;
  }
  const key=[kind,docEntry||document,day,lineNo].join('|');
  const row:AqabaLine={key,kind,document,docEntry,date:day,customer,warehouse,row:lineNo!,
   item,description:read(cells,'description'),unit:normalizeAqabaUnit(read(cells,'unit')),
   quantity:qty,unitPrice:price,lineTotal:number(read(cells,'total'))??Number((qty*price).toFixed(3)),
   tax:number(read(cells,'tax'))??0,canceled:status,baseType:read(cells,'baseType'),
   baseEntry:read(cells,'baseEntry'),baseLine:read(cells,'baseLine'),baseRef:read(cells,'baseRef'),
   inventoryEffect:'unverified'};
  const serialized=JSON.stringify(row),prior=found.get(key);
  if(prior!==undefined){if(prior!==serialized)issues.push('تعارض في مستند '+document+' السطر '+lineNo+'.');continue}
  found.set(key,serialized);items.push(row);
 }
 if(!items.length)issues.push('لا توجد بنود رسمية صالحة للعقبة ضمن الفترة.');
 return {items,issues};
}
export function readAqabaBlue(source:string):ReadResult<BlueLine>{
 const {rows,header}=table(source),issues:string[]=[],items:BlueLine[]=[];
 const ix={
 invoice:field(header,['رقم الفاتورة الزرقاء','رقم الفاتورة','invoice']),
 date:field(header,['التاريخ','تاريخ الفاتورة','date']),
 item:field(header,['كود SAP','كود الصنف','itemcode','item no.']),
 description:field(header,['اسم الصنف','الوصف','description']),
 qty:field(header,['الكمية','qty','quantity']),
 unit:field(header,['الوحدة','uom','unit']),
 price:field(header,['السعر','سعر الوحدة','price']),
 official:field(header,['أرقام الفواتير الرسمية','الفاتورة الرسمية','official invoices']),
 transfers:field(header,['أرقام الترحيلات','الترحيلات','transfers']),
 };
 if(['invoice','date','item','qty','unit','price'].some(k=>(ix as Record<string,number>)[k]<0))
  return {items,issues:['الأعمدة المطلوبة: رقم الفاتورة الزرقاء، التاريخ، كود SAP، الكمية، الوحدة، السعر.']};
 const seen=new Set<string>();
 const occurrence=new Map<string,number>();
 for(let n=1;n<rows.length;n++){
  const r=rows[n],v=(k:keyof typeof ix)=>ix[k]>=0?(r[ix[k]]||'').trim():'',
   invoice=digits(v('invoice')),day=date(v('date')),item=v('item').toUpperCase(),
   qty=number(v('qty')),price=number(v('price')),unit=normalizeAqabaUnit(v('unit'));
  if(!/^\d{7,20}$/.test(invoice)||!day||day<AQABA_START||!/^[A-Z]{2,6}\d{3,10}$/.test(item)||
     qty===null||qty<0||price===null||price<0||!unit){
   issues.push('السطر '+(n+1)+': بيانات الفاتورة الزرقاء غير صالحة.');continue;
  }
  const stem=invoice+'|'+item,seq=(occurrence.get(stem)||0)+1;
  occurrence.set(stem,seq);
  const key=stem+'|'+seq;
  if(seen.has(key))continue;seen.add(key);
  items.push({key,invoice,date:day,item,description:v('description'),quantity:qty,unit,
    price,officialNumbers:codes(v('official')),transferNumbers:codes(v('transfers'))});
 }
 if(!items.length)issues.push('لا توجد أصناف زرقاء صالحة.');
 return {items,issues};
}
/** Compare only confirmed invoice references and same inventory unit; do not
 * silently guess carton conversions or group by date alone. */
export function compareAqaba(blue:BlueLine[],official:AqabaLine[]){
 const groups=new Map<string,BlueLine[]>();
 for(const item of blue){const a=groups.get(item.invoice)||[];a.push(item);groups.set(item.invoice,a)}
 return [...groups].map(([invoice,rows])=>{
  const linked=[...new Set(rows.flatMap(r=>r.officialNumbers))];
  const refs=official.filter(o=>linked.includes(o.document)&&o.kind==='IN');
  const issues:string[]=[];
  if(!linked.length)issues.push('لا توجد فاتورة رسمية مربوطة برقم مثبت.');
  for(const no of linked)if(!refs.some(r=>r.document===no))issues.push('الفاتورة الرسمية '+no+' غير موجودة بالكشف.');
  const comparable=refs.length>0&&linked.every(n=>refs.some(r=>r.document===n))&&
    refs.every(r=>r.canceled==='N');
  if(refs.some(r=>r.canceled!=='N'))issues.push('حالة إلغاء فاتورة رسمية غير مؤكدة أو ملغاة.');
  const total=(all:{item:string;unit:string;quantity:number}[])=>{
    const sums=new Map<string,number>();
    for(const r of all){const key=r.item+'|'+r.unit;sums.set(key,(sums.get(key)||0)+r.quantity)}
    return sums;
  };
  const left=total(rows),right=total(refs),keys=[...new Set([...left.keys(),...right.keys()])];
  const differences=comparable?keys.map(key=>({key,blue:left.get(key)||0,official:right.get(key)||0,
    difference:Number(((left.get(key)||0)-(right.get(key)||0)).toFixed(6))})).filter(x=>Math.abs(x.difference)>0.000001):[];
  if(comparable&&differences.length)issues.push('فرق أصناف/كميات في الفاتورة الرسمية.');
  const transfers=[...new Set(rows.flatMap(r=>r.transferNumbers))];
  if(!transfers.length)issues.push('ترحيلات SAP لم تُربط بعد؛ المطابقة الثلاثية غير مكتملة.');
  return {invoice,officialNumbers:linked,transferNumbers:transfers,
    status:!issues.length?'كميات الزرقاء والرسمية متفقة؛ الترحيل يحتاج تحقق':'بحاجة مراجعة',
    differences,issues};
 });
}


export type AqabaTransfer={
 key:string;document:string;docEntry:string;date:string;row:number;remarks:string;
 canceled:string;item:string;description:string;unit:string;quantity:number;
 from:string;to:string;classified:'aqaba-remark'|'unclassified';
};
/** A transfer is an AQABA candidate when Remarks mention Aqaba. Customer ownership
 * is never established just by the shared destination warehouse 011. */
export function readAqabaTransfers(source:string):ReadResult<AqabaTransfer>{
 const {rows,header}=table(source),issues:string[]=[],items:AqabaTransfer[]=[];
 const fields={
  doc:['رقم الترحيل','transfer number','docnum'],entry:['docentry'],
  date:['التاريخ','posting date'],remark:['remarks','comments','الملاحظات'],
  canceled:['حالة الإلغاء','canceled'],row:['رقم السطر','line number'],
  item:['كود الصنف','item no.','itemcode'],description:['اسم الصنف','description'],
  unit:['الوحدة','uom'],qty:['الكمية','quantity'],
  from:['من المستودع','from warehouse'],to:['إلى المستودع','to warehouse'],
 } as const;
 const ix=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,field(header,[...v])]));
 if(['doc','date','row','item','qty','from','to','remark','canceled'].some(k=>ix[k]<0))
  return {items,issues:['كشف الترحيلات ناقص: رقم الترحيل، التاريخ، السطر، الصنف، الكمية، من وإلى، Remarks، حالة الإلغاء.']};
 const at=(r:string[],k:string)=>ix[k]<0?'':(r[ix[k]]||'').trim();
 const seen=new Set<string>();
 for(let i=1;i<rows.length;i++){
  const r=rows[i],document=digits(at(r,'doc')),docEntry=digits(at(r,'entry')),
  day=date(at(r,'date')),row=number(at(r,'row')),quantity=number(at(r,'qty')),
  item=at(r,'item').toUpperCase(),from=digits(at(r,'from')).padStart(3,'0'),
  to=digits(at(r,'to')).padStart(3,'0'),canceled=at(r,'canceled').toUpperCase();
  if(!/^\d{4,20}$/.test(document)||!day||day<AQABA_START||
    !Number.isInteger(row)||row!<1||quantity===null||quantity<0||
    !/^[A-Z]{2,6}\d{3,10}$/.test(item)||!['001','002','009','011'].includes(from)||
    !['001','002','009','011'].includes(to)||from===to||
    (from!=='011'&&to!=='011')||!['N','Y','C'].includes(canceled)){
   issues.push('السطر '+(i+1)+': ترحيل غير صالح أو خارج مسارات العقبة.');continue;
  }
  const key=[docEntry||document,day,row].join('|');
  if(seen.has(key)){issues.push('سطر ترحيل مكرر: '+document+' / '+row);continue}
  seen.add(key);
  const remarks=at(r,'remark');
  const classified=/(?:العقب[ةه]|عقب[ةه]|aqaba|akaba)/i.test(remarks)?'aqaba-remark':'unclassified';
  if(classified==='unclassified')issues.push('الترحيل '+document+': لا يوجد دليل عقبة في Remarks؛ بحاجة تأكيد.');
  items.push({key,document,docEntry,date:day,row:row!,remarks,canceled,item,
    description:at(r,'description'),unit:normalizeAqabaUnit(at(r,'unit')),
    quantity,from,to,classified});
 }
 if(!items.length)issues.push('لا توجد ترحيلات SAP صالحة.');
 return {items,issues};
}
export type AqabaTripleReview={
 blueInvoices:string[];transferNumbers:string[];officialNumbers:string[];
 issues:string[];differences:{key:string;blue:number;transferred:number;difference:number}[];
 state:'incomplete'|'quantity-difference'|'quantity-aligned-not-stock-verified';
};
/** Multiple blue pages often share one SAP transfer. Compare the combined
 * connected group, never the entire transfer against each blue page individually.
 * Even aligned quantities do not prove a stock movement without OINM.
 */
export function reviewAqabaTransfers(
 blue:BlueLine[],transfers:AqabaTransfer[],cartonPieces:Record<string,number>={},
):AqabaTripleReview[]{
 const invoices=new Map<string,BlueLine[]>();
 for(const row of blue)invoices.set(row.invoice,[...(invoices.get(row.invoice)||[]),row]);
 const owners=[...invoices.keys()],parent=new Map(owners.map(n=>[n,n]));
 const root=(x:string):string=>{const p=parent.get(x)!;return p===x?x:root(p)};
 const byTransfer=new Map<string,string>();
 for(const [invoice,rows] of invoices)for(const no of rows.flatMap(r=>r.transferNumbers)){
  const prior=byTransfer.get(no);
  if(prior)parent.set(root(invoice),root(prior));
  else byTransfer.set(no,invoice);
 }
 const groups=new Map<string,BlueLine[]>();
 for(const [invoice,rows] of invoices){const r=root(invoice);groups.set(r,[...(groups.get(r)||[]),...rows])}
 const result:AqabaTripleReview[]=[];
 const converted=(row:{item:string;quantity:number;unit:string},issues:string[])=>{
  const pack=cartonPieces[row.item],unit=normalizeAqabaUnit(row.unit);
  if(unit==='Piece')return {key:row.item+'|Piece',qty:row.quantity};
  if(unit==='Carton'&&Number.isInteger(pack)&&pack>0)
    return {key:row.item+'|Piece',qty:row.quantity*pack};
  if(!unit)issues.push('الصنف '+row.item+': وحدة القياس مفقودة.');
  return {key:row.item+'|'+(unit||'UNKNOWN'),qty:row.quantity};
 };
 for(const rows of groups.values()){
  const blueInvoices=[...new Set(rows.map(r=>r.invoice))].sort(),
    transferNumbers=[...new Set(rows.flatMap(r=>r.transferNumbers))],
    officialNumbers=[...new Set(rows.flatMap(r=>r.officialNumbers))],
    matching=transfers.filter(r=>transferNumbers.includes(r.document)),
    issues:string[]=[];
  if(!transferNumbers.length)issues.push('لا يوجد رقم ترحيل مرتبط بالفواتير الزرقاء.');
  for(const no of transferNumbers)if(!matching.some(r=>r.document===no))issues.push('الترحيل '+no+' غير موجود بالكشف.');
  if(matching.some(r=>r.classified!=='aqaba-remark'))issues.push('يوجد ترحيل لم تثبت نسبته للعقبة من Remarks.');
  if(matching.some(r=>r.canceled!=='N'))issues.push('ترحيل ملغي أو مستند إلغاء: راجع الأصل والمقابل وحركة OINM.');
  if(matching.some(r=>r.from==='011'))issues.push('ترحيل عكسي من 011: يحتاج تدقيق أثر الحركة الأصلي.');
  const left=new Map<string,number>(),right=new Map<string,number>();
  for(const row of rows){
   const q=converted(row,issues);left.set(q.key,(left.get(q.key)||0)+q.qty);
  }
  for(const row of matching.filter(r=>r.canceled==='N')){
   const q=converted(row,issues);right.set(q.key,(right.get(q.key)||0)+(row.to==='011'?q.qty:-q.qty));
  }
  const all=[...new Set([...left.keys(),...right.keys()])];
  const differences=matching.length&&transferNumbers.every(n=>matching.some(r=>r.document===n))?
    all.map(key=>({key,blue:left.get(key)||0,transferred:right.get(key)||0,
      difference:Number(((left.get(key)||0)-(right.get(key)||0)).toFixed(6))}))
      .filter(x=>Math.abs(x.difference)>0.000001):[];
  if(differences.length)issues.push('فرق بين كميات الزرقاء وصافي ترحيلات SAP.');
  result.push({blueInvoices,transferNumbers,officialNumbers,issues,differences,
   state:issues.length?'incomplete':differences.length?'quantity-difference':'quantity-aligned-not-stock-verified'});
 }
 return result;
}


export type AqabaMovement={
 key:string;transNum:string;date:string;transType:string;docEntry:string;
 document:string;row:number;item:string;description:string;warehouse:'011';
 incoming:number;outgoing:number;customer:string;
};
export function readAqabaJournal(source:string):ReadResult<AqabaMovement>{
 const {rows,header}=table(source),items:AqabaMovement[]=[],issues:string[]=[];
 const names={
  trans:['معرف حركة المخزون','transnum'],date:['التاريخ','posting date'],
  type:['نوع حركة SAP','transtype'],entry:['docentry','createdby'],
  doc:['رقم المستند','base_ref'],row:['رقم السطر','doclinenum'],
  item:['كود الصنف','itemcode'],description:['اسم الصنف','description'],
  warehouse:['المستودع','warehouse'],incoming:['الوارد','inqty'],
  outgoing:['الصادر','outqty'],customer:['رقم الزبون','cardcode']
 } as const;
 const ix=Object.fromEntries(Object.entries(names).map(([k,v])=>[k,field(header,[...v])]));
 if(Object.values(ix).some(x=>x<0))return {items,issues:['كشف OINM يجب أن يحتوي جميع الأعمدة الموضحة في الكويري.']};
 const read=(r:string[],k:string)=>(r[ix[k]]||'').trim();
 const seen=new Set<string>();
 for(let i=1;i<rows.length;i++){
  const r=rows[i],transNum=digits(read(r,'trans')),day=date(read(r,'date')),
    transType=digits(read(r,'type')),docEntry=digits(read(r,'entry')),
    document=digits(read(r,'doc')),row=number(read(r,'row')),
    item=read(r,'item').toUpperCase(),warehouse=digits(read(r,'warehouse')).padStart(3,'0'),
    incoming=number(read(r,'incoming')),outgoing=number(read(r,'outgoing'));
  if(!/^\d{1,20}$/.test(transNum)||!day||day<AQABA_START||!/^-?\d{1,12}$/.test(transType)||
     !Number.isInteger(row)||row===null||row<0||row>20000||
     !/^[A-Z]{2,6}\d{3,10}$/.test(item)||warehouse!=='011'||
     incoming===null||outgoing===null||incoming<0||outgoing<0){
   issues.push('السطر '+(i+1)+': حركة مخزون غير صالحة.');continue;
  }
  const key=[transNum,transType,docEntry,row,item].join('|');
  if(seen.has(key)){issues.push('حركة مخزون مكررة: '+key);continue}seen.add(key);
  items.push({key,transNum,date:day,transType,docEntry,document,row,item,
   description:read(r,'description'),warehouse:'011',incoming,outgoing,customer:read(r,'customer')});
 }
 if(!items.length)issues.push('لا توجد حركات OINM صالحة.');
 return {items,issues};
}
/** This is physical inventory evidence; it NEVER subtracts a sales invoice
 * in addition to the OINM journal. Unknown movement owners stay unknown. */
export function auditAqabaJournal(
 movements:AqabaMovement[],official:AqabaLine[],transfers:AqabaTransfer[],
){
 const types:Record<string,AqabaDocumentKind>={'13':'IN','14':'CN','15':'DN','16':'RE'};
 const officialEntries=new Set(official.filter(r=>r.docEntry).map(r=>r.kind+'|'+r.docEntry+'|'+r.item));
 const transferEntries=new Set(transfers.filter(r=>r.docEntry&&r.classified==='aqaba-remark')
    .map(r=>r.docEntry+'|'+r.item));
 let inward=0,outward=0,verifiedAqabaIncoming=0,verifiedAqabaOutgoing=0;
 const issues:string[]=[],unassigned:AqabaMovement[]=[];
 const rows=movements.map(m=>{
  const ownerKind=types[m.transType];
  const officialMatch=ownerKind&&officialEntries.has(ownerKind+'|'+m.docEntry+'|'+m.item);
  const transferMatch=m.transType==='67'&&transferEntries.has(m.docEntry+'|'+m.item);
  const customerMatch=m.customer===AQABA_CUSTOMER;
  const otherCustomer=!!m.customer&&!customerMatch;
  const assigned=otherCustomer?'other-customer':
   (officialMatch||transferMatch||customerMatch?'aqaba-evidence':'unknown');
  const net=m.incoming-m.outgoing;
  inward+=m.incoming;outward+=m.outgoing;
  if(assigned==='aqaba-evidence'){
   verifiedAqabaIncoming+=m.incoming;verifiedAqabaOutgoing+=m.outgoing;
  }else if(assigned==='unknown')unassigned.push(m);
  return {...m,net,assigned};
 });
 if(unassigned.length)issues.push(unassigned.length+' حركة 011 لم تُنسب لعمّان أو العقبة بدليل مثبت.');
 if(!movements.length)issues.push('لا يوجد كشف OINM؛ لا يمكن احتساب أثر حركة البيع على الرصيد.');
 return {rows,issues,unassigned,
  physical:{incoming:inward,outgoing:outward,net:Number((inward-outward).toFixed(6))},
  aqabaEvidence:{incoming:verifiedAqabaIncoming,outgoing:verifiedAqabaOutgoing,
   net:Number((verifiedAqabaIncoming-verifiedAqabaOutgoing).toFixed(6))}};
}
