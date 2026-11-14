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
 if(['invoice','date','item','qty','unit','price'].some(k=>ix[k]<0))
  return {items,issues:['الأعمدة المطلوبة: رقم الفاتورة الزرقاء، التاريخ، كود SAP، الكمية، الوحدة، السعر.']};
 const seen=new Set<string>();
 for(let n=1;n<rows.length;n++){
  const r=rows[n],v=(k:keyof typeof ix)=>ix[k]>=0?(r[ix[k]]||'').trim():'',
   invoice=digits(v('invoice')),day=date(v('date')),item=v('item').toUpperCase(),
   qty=number(v('qty')),price=number(v('price')),unit=normalizeAqabaUnit(v('unit'));
  if(!/^\d{7,20}$/.test(invoice)||!day||day<AQABA_START||!/^[A-Z]{2,6}\d{3,10}$/.test(item)||
     qty===null||qty<0||price===null||price<0||!unit){
   issues.push('السطر '+(n+1)+': بيانات الفاتورة الزرقاء غير صالحة.');continue;
  }
  const key=invoice+'|'+n;
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
