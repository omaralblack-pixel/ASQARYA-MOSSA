export type SapAlias={sapCode:string;sapUnit:string;cartonPieces:number|null;kgPerPiece:number|null};
export type Item={sapAliases?:SapAlias[];code:string;sapCode:string;name:string;sourceName?:string;price:number|null;invoicePack:number|null;cartonPieces:number|null;sapUnit:string;warehouseUnit?:string|null;warehouseName?:string|null;kgPerPiece:number|null;active:boolean};
export type TransferLine={transferNo?:string;row:number;sapCode:string;name:string;quantity:number;unit:string;from:string;to:string};
export type Invoice={id:string;title?:string;number:string;date:string;amount:string;complete:boolean;attachments?:{key:string;name:string;type:string}[];quantities:Record<string,string>};
export type Transfer={id:string;number:string;date:string;paste:string};
export type Draft={mode?:'manual';checks?:Record<string,{signature:string;state:'match'|'difference';note?:string}>;pages?:Record<string,string>;id?:string;version?:number;branch:string;driver:string;date:string;transfers:Transfer[];invoices:Invoice[];notes:string;referenceSnapshot?:Item[];useCurrentReference?:boolean;linkedSapCodes?:string[]};
export function digits(v:string){return v.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))}
export function numeric(v:unknown):number|null{const s=digits(String(v??'')).trim().replace(/٬/g,',').replace(/٫/g,'.');if(!s)return null;if(!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s))return null;const n=Number(s.replace(/,/g,''));return Number.isFinite(n)?n:null}
export function fils(v:string):number|null{
 const amount=digits(v).trim().replace(/^(\d+),(\d{1,2})$/,'$1.$2').replace(/^(\d+)،(\d{1,3})$/,'$1.$2');
 const n=numeric(amount);if(n===null||n<0||n>100000000||Math.abs(n*1000-Math.round(n*1000))>0.00001)return null;return Math.round(n*1000)}
export const money=(n:number|null)=>n===null?'—':(n/1000).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
export const num=(n:number|null)=>n===null?'—':String(Number(n.toFixed(6)));
const header=(s:string)=>s.toLowerCase().replace(/[\s._\-:]/g,'');
const wh=(s:string)=>/^\d+$/.test(digits(s.trim()))?digits(s.trim()).padStart(3,'0'):s.trim();
export function parseTransfer(paste:string){const lines:TransferLine[]=[],issues:string[]=[],excluded:string[]=[];const raw=paste.replace(/\r/g,'').split('\n');const h=raw.findIndex(l=>l.split('\t').some(c=>['itemno','itemcode'].includes(header(c))));if(h<0)return {lines,issues:paste.trim()?['لم أجد عناوين SAP. انسخ الجدول مع سطر العناوين، بما فيه Item No. وQuantity وUoM.']:[],excluded};const cols=raw[h].split('\t').map(header);const col=(options:string[])=>cols.findIndex(c=>options.includes(c));const code=col(['itemno','itemcode']),qty=col(['quantity']),unit=col(['uomname','uomcode','uom','inventoryuom']),name=col(['itemdescription','description']),from=col(['fromwarehouse','fromwhse']),to=col(['towarehouse','towhse']);if([code,qty,unit,from,to].some(i=>i<0))return {lines,issues:['الأعمدة المطلوبة: Item No.، Quantity، UoM Name أو UoM Code، From Warehouse، To Warehouse.'],excluded};
for(let i=h+1;i<raw.length;i++){if(!raw[i].trim())continue;const c=raw[i].split('\t'),sapCode=(c[code]||'').trim().toUpperCase();if(['itemno','itemcode'].includes(header(c[code]||''))&&c.some(cell=>header(cell)==='quantity'))continue;if(!sapCode){issues.push('سطر '+(i+1)+': بلا كود صنف؛ راجعه قبل الاعتماد.');continue}if(!/^[A-Z]{2,6}\d{3,10}$/.test(sapCode)){issues.push('سطر '+(i+1)+': كود غير صالح '+sapCode);continue}const f=wh(c[from]||''),t=wh(c[to]||'');if(!f||!t){issues.push('سطر '+(i+1)+': بيانات المستودعات ناقصة');continue}if(!['001','002'].includes(f)||t!=='011'){excluded.push('سطر '+(i+1)+' '+sapCode+': '+f+' إلى '+t);continue}const quantity=numeric(c[qty]),u=(c[unit]||'').trim();if(quantity===null||quantity<0||quantity>100000000){issues.push('سطر '+(i+1)+': كمية غير صالحة');continue}if(!['piece','carton','kg'].includes(u.toLowerCase())){issues.push('سطر '+(i+1)+': وحدة غير معروفة '+u);continue}lines.push({row:i+1,sapCode,name:c[name]||'',quantity,unit:u.toLowerCase()==='piece'?'Piece':u.toLowerCase()==='carton'?'Carton':'KG',from:f,to:t})}return {lines,issues,excluded}}
export function convert(l:TransferLine,item:Item):number{if(l.unit==='Piece')return l.quantity;if(l.unit==='Carton'){if(!item.cartonPieces||item.cartonPieces<=0)throw Error('شدّة الكرتونة غير محددة');return l.quantity*item.cartonPieces}if(l.unit==='KG'){if(!item.kgPerPiece||item.kgPerPiece<=0)throw Error('يلزم تحديد وزن الحبة بالكغم');return l.quantity/item.kgPerPiece}throw Error('الوحدة غير معروفة')}
export function sapReferences(items:Item[]):Item[]{
 return items.flatMap(item=>[item,...(item.sapAliases||[]).map(({sapCode,sapUnit,cartonPieces,kgPerPiece})=>({...item,sapCode,sapUnit,cartonPieces,kgPerPiece}))]);
}
export function groupReference(snapshot:Item[]|undefined,current:Item[],linkedSapCodes:string[]=[]){
 if(!snapshot)return current;
 const linked=current.filter(item=>linkedSapCodes.includes(item.sapCode)||item.sapAliases?.some(alias=>linkedSapCodes.includes(alias.sapCode)));
 return [...snapshot.filter(item=>!linked.some(link=>link.sapCode===item.sapCode||link.code===item.code)),...linked];
}
export function moveLinkedPage(pages:Draft['pages'],sapCode:string,code:string){
 const next={...pages};
 const source='s:'+sapCode,target='i:'+code;
 if(pageNumber(next[source])>0&&pageNumber(next[target])===0)next[target]=next[source];
 delete next[source];
 return next;
}
export function reconcile(d:Draft,reference:Item[]){if(d.mode==='manual')return reconcileManual(d,reference);return reconcileLegacy(d,reference)}
function reconcileLegacy(d:Draft,reference:Item[]){const parsed={lines:[] as TransferLine[],issues:[] as string[],excluded:[] as string[]};for(const [index,t] of d.transfers.entries()){const p=parseTransfer(t.paste);parsed.lines.push(...p.lines.map(l=>({...l,transferNo:t.number})));parsed.issues.push(...p.issues.map(i=>'الترحيل '+(t.number||index+1)+': '+i));parsed.excluded.push(...p.excluded.map(i=>'الترحيل '+(t.number||index+1)+': '+i))}const active=reference.filter(i=>i.active),bySap=new Map(sapReferences(active).map(i=>[i.sapCode,i])),byCode=new Map(active.map(i=>[i.code,i]));const problems=[...parsed.issues];const transferNos=d.transfers.map(t=>documentNo(t.number));if(transferNos.some(n=>!n))problems.push('أكمل أرقام الترحيلات');if(new Set(transferNos).size!==transferNos.length)problems.push('رقم ترحيل مكرر داخل المجموعة');if(!d.transfers.length)problems.push('أضف ترحيلًا واحدًا على الأقل');if(!parsed.lines.length)problems.push('أضف ترحيل SAP صالحًا للمطابقة');if(!d.invoices.length)problems.push('أضف فاتورة مؤسسة واحدة على الأقل');const numbers=d.invoices.map(i=>digits(i.number.trim()));if(numbers.some(n=>!n))problems.push('أكمل أرقام الفواتير');if(new Set(numbers).size!==numbers.length)problems.push('رقم فاتورة مكرر داخل المجموعة');if(d.invoices.some(i=>!i.complete))problems.push('أكّد اكتمال بنود كل فاتورة بعد إدخالها');if(d.invoices.some(i=>fils(i.amount)===null))problems.push('أكمل مبلغ كل فاتورة بدقة حتى 3 منازل');
const rows=new Map<string,{key:string;item:Item|null;sapCode:string;code:string;name:string;transfer:number|null;invoice:number;details:TransferLine[];errors:string[];perInvoice:(number|null)[];unitPrice:number|null;expected:number|null;difference:number|null;state:string}>();
const ensure=(key:string,item:Item|null,sapCode:string,code:string,name:string)=>{if(!rows.has(key))rows.set(key,{key,item,sapCode,code,name,transfer:0,invoice:0,details:[],errors:[],perInvoice:d.invoices.map(()=>0),unitPrice:item?.price??null,expected:null,difference:null,state:''});return rows.get(key)!};
for(const l of parsed.lines){const item=bySap.get(l.sapCode)||null;const r=ensure(item?'i:'+item.code:'s:'+l.sapCode,item,l.sapCode,item?.code||'',item?.name||l.name);r.details.push(l);if(!item){r.transfer=null;if(!r.errors.includes('كود SAP غير مربوط بصنف مؤسسة معتمد'))r.errors.push('كود SAP غير مربوط بصنف مؤسسة معتمد');continue}try{const q=convert(l,item);if(r.transfer!==null)r.transfer+=q}catch(e:any){r.transfer=null;r.errors.push(e.message)}}
for(const [j,inv] of d.invoices.entries())for(const [code,value] of Object.entries(inv.quantities)){if(!String(value).trim())continue;const item=byCode.get(code)||null;const r=ensure('i:'+code,item,item?.sapCode||'',code,item?.name||'رقم مؤسسة غير معرّف');if(!item)r.errors.push('رقم المؤسسة غير معرّف في القائمة المعتمدة');const q=numeric(value);if(q===null||q<0||q>100000000){r.perInvoice[j]=null;r.errors.push('كمية الفاتورة '+(j+1)+' غير صالحة')}else{r.perInvoice[j]=q;r.invoice+=q}}
for(const r of rows.values()){r.difference=r.transfer===null?null:Number((r.invoice-r.transfer).toFixed(6));r.expected=r.transfer===null||r.unitPrice===null?null:Math.round(r.transfer*r.unitPrice);r.state=r.errors.length?'review':r.difference===0?'match':r.transfer===0&&r.invoice>0?'invoiceOnly':r.invoice===0&&(r.transfer||0)>0?'transferOnly':'difference'}
const result=[...rows.values()];const review=result.filter(r=>r.state==='review').length,differences=result.filter(r=>!['match','review'].includes(r.state)).length;const total=filsSum(d.invoices.map(i=>i.amount));const expected=result.length&&result.every(r=>r.expected!==null)?result.reduce((s,r)=>s+r.expected!,0):null;const invoiceCalculated=d.invoices.map((inv,j)=>result.every(r=>r.perInvoice[j]===0||r.perInvoice[j]!==null&&r.unitPrice!==null)?result.reduce((s,r)=>s+Math.round((r.perInvoice[j]||0)*(r.unitPrice||0)),0):null);const invoiceAmountDiffs=invoiceCalculated.map((v,j)=>v===null||fils(d.invoices[j].amount)===null?null:fils(d.invoices[j].amount)!-v);const priceDifference=total===null||expected===null?null:total-expected;const status=problems.length||review?'review':differences?'difference':priceDifference===null?'quantityMatch':priceDifference!==0||invoiceAmountDiffs.some(v=>v!==null&&v!==0)?'difference':'match';return {parsed,rows:result,problems,review,differences,total,expected,priceDifference,invoiceCalculated,invoiceAmountDiffs,status}}
function filsSum(values:string[]){const n=values.map(fils);return n.some(v=>v===null)?null:n.reduce<number>((s,v)=>s+v!,0)}
export const labels:Record<string,string>={review:'بحاجة مراجعة',difference:'يوجد فرق',match:'مطابق',quantityMatch:'الكميات مطابقة؛ الأسعار ناقصة',invoiceOnly:'في الفواتير فقط',transferOnly:'في الترحيل فقط'};

export function documentNo(s:string){return digits(s).trim().replace(/,/g,'').replace(/\s+/g,' ')}
export function dateValue(s:string,format='dmy'):string|null{const n=digits(String(s)).trim().split(' ')[0];let m=n.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);let y,mo,day;if(m){y=+m[1];mo=+m[2];day=+m[3]}else{m=n.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);if(!m)return null;y=+m[3];mo=+(format==='mdy'?m[1]:m[2]);day=+(format==='mdy'?m[2]:m[1])}const d=new Date(Date.UTC(y,mo-1,day));if(d.getUTCFullYear()!==y||d.getUTCMonth()!==mo-1||d.getUTCDate()!==day)return null;return `${y}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`}
export function pageNumber(value?: string) {
  return Number(digits(value ?? '').trim()) || 0;
}
const transferNumberPattern = /^(?:\d+|\d{1,3}(?:[,٬]\d{3})+)$/;
export function isTransferNumber(value: string) {
  return transferNumberPattern.test(digits(value.trim()));
}
export function transferNumbers(value: string) {
  return value.split(/[+،]/).map(number => documentNo(number.replace(/٬/g, ','))).filter(Boolean);
}
export function serialHeaders(paste:string){return (paste.replace(/\r/g,'').split('\n').find(l=>l.trim())||'').split('\t').map(s=>s.trim())}
export function monthly(paste:string,month:string,columns:{number:number;date:number;branch:number},filtered:boolean,format:string,groups:any[]){
 const result={missing:[] as any[],received:[] as any[],pending:[] as any[],outside:[] as any[],extra:[] as any[],problems:[] as string[],duplicates:[] as string[]};
 const lines=paste.replace(/\r/g,'').split('\n').filter(line=>line.trim());
 const plainNumbers=lines.every(isTransferNumber);
 const hasDate=!plainNumbers&&columns.date>=0;
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||!lines.length){
  result.problems.push('حدد الشهر وألصق أرقام الترحيلات أو جدول SAP');
 }else if(!plainNumbers&&columns.number<0){
  result.problems.push('اختر عمود رقم الترحيل');
 }else if(!hasDate&&!filtered){
  result.problems.push('اختر عمود التاريخ أو أكّد أن الكشف مفلتر للشهر المحدد');
 }
 if(result.problems.length)return result;

 const saved=new Map<string,{group:any;date:string|null;complete:boolean}>();
 for(const group of groups){
  const draft=typeof group.payload==='string'?JSON.parse(group.payload):group.payload;
  const complete=Boolean(draft.invoices?.length)&&draft.invoices.every((invoice:Invoice)=>invoice.number?.trim()&&invoice.complete);
  for(const transfer of draft.transfers||[]){
   for(const number of transferNumbers(transfer.number||'')){
    if(!saved.has(number))saved.set(number,{group,date:dateValue(transfer.date||''),complete});
   }
  }
 }
 const seen=new Set<string>();
 const numberColumn=plainNumbers?0:columns.number;
 const numberHeader=plainNumbers?'':header(serialHeaders(paste)[numberColumn]||'');
 for(let i=plainNumbers?0:1;i<lines.length;i++){
  const cells=lines[i].split('\t');
  const rawNumber=cells[numberColumn]||'';
  if(numberHeader&&header(rawNumber)===numberHeader)continue;
  if(!isTransferNumber(rawNumber)){
   result.problems.push('سطر '+(i+1)+': رقم ترحيل غير صالح');
   continue;
  }
  const number=transferNumbers(rawNumber)[0];
  const date=hasDate?dateValue(cells[columns.date]||'',format):null;
  if(hasDate&&!date){
   result.problems.push('سطر '+(i+1)+' '+number+': تاريخ غير صالح');
   continue;
  }
  if(date&&!date.startsWith(month)){
   result.outside.push({number,date});
   continue;
  }
  if(seen.has(number)){
   result.duplicates.push(number);
   continue;
  }
  seen.add(number);
  const entry=saved.get(number);
  const row={number,date:date||month,branch:!plainNumbers&&columns.branch>=0?cells[columns.branch]||'':''};
  if(!entry){
   result.missing.push(row);
  }else if(!entry.date?.startsWith(month)){
   result.problems.push('الترحيل '+number+' محفوظ بتاريخ مختلف أو غير صالح؛ راجع التاريخين');
   result.pending.push({...row,group:entry.group,reason:'اختلاف تاريخ'});
  }else if(!entry.complete){
   result.pending.push({...row,group:entry.group,reason:'الفواتير غير مكتملة'});
  }else{
   result.received.push({...row,group:entry.group});
  }
 }
 result.extra=[...saved].filter(([number,entry])=>entry.date?.startsWith(month)&&!seen.has(number))
  .map(([number,entry])=>({number,branch:entry.group.branch,date:entry.date,group:entry.group}));
 return result;
}

export function checkSignature(r:{name:string;unitPrice:number|null;transfer:number|null;details:TransferLine[]}){return JSON.stringify([r.name,r.unitPrice,r.transfer,r.details.map(l=>[l.transferNo,l.sapCode,l.quantity,l.unit,l.from,l.to]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])}
function reconcileManual(d:Draft,reference:Item[]){
 const base=reconcileLegacy({...d,mode:undefined,invoices:d.invoices.map(i=>({...i,complete:true,quantities:{}}))},reference);
 const problems=base.problems.filter(p=>!p.includes('اكتمال بنود'));
 if(d.invoices.some(i=>!i.complete))problems.push('أكد وجود كل فاتورة ورقية للمجموعة');
 const rows=base.rows.map(r=>{const c=d.checks?.[r.key],valid=c?.signature===checkSignature(r);const state=r.errors.length?'review':'match';return {...r,invoice:0,difference:null,state}});
 const unchecked=0,review=rows.filter(r=>r.state==='review').length,differences=0;
 for(const r of rows){const page=d.pages?.[r.key];if(page&&(!/^\d+$/.test(digits(page))||pageNumber(page)>d.invoices.length))problems.push('رقم الفاتورة الزرقاء للصنف '+(r.code||r.sapCode)+' غير موجود في الفواتير المسجلة');}
 const status=review||problems.length?'review':differences||base.priceDifference!==null&&base.priceDifference!==0?'difference':base.priceDifference===null?'priceMissing':'match';
 return {...base,rows,problems,review:review+unchecked,differences,status,invoiceCalculated:d.invoices.map(()=>null),invoiceAmountDiffs:d.invoices.map(()=>null)};
}
labels.unchecked='لم يُشيّك';labels.priceMissing='التشييك مكتمل؛ الأسعار ناقصة';
