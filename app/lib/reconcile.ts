export type SapAlias={sapCode:string;sapUnit:string;cartonPieces:number|null;kgPerPiece:number|null};
export type Item={sapAliases?:SapAlias[];code:string;sapCode:string;name:string;sourceName?:string;price:number|null;invoicePack:number|null;cartonPieces:number|null;sapUnit:string;warehouseUnit?:string|null;warehouseName?:string|null;kgPerPiece:number|null;active:boolean};
export type TransferLine={transferNo?:string;row:number;sapCode:string;name:string;quantity:number;unit:string;from:string;to:string};
/** Stable identity for an SAP source row. Persist allocations against this key. */
export const soldierLineKey=(transferId:string,line:Pick<TransferLine,'row'|'sapCode'>)=>
 'l:'+transferId+':'+line.row+':'+line.sapCode.toUpperCase();
export type Invoice={id:string;title?:string;number:string;date:string;dateTransferNos?:string[];manualDate?:boolean;manualNumber?:boolean;amount:string;complete:boolean;attachments?:{key:string;name:string;type:string}[];auditLines?:string;sapInstitutionChoices?:Record<string,string>;quantities:Record<string,string>};
export type Transfer={id:string;number:string;date:string;paste:string};
export type TransferSource = {number: string; recordId: string; version: number};
export type Draft={pageEntryOrder?:string[];excludedItems?:Record<string,string>;mode?:'manual';acceptedDifference?:{paper:number;calculated:number};checks?:Record<string,{signature:string;state:'match'|'difference';note?:string}>;pages?:Record<string,string>;id?:string;version?:number;branch:string;driver:string;date:string;transfers:Transfer[];invoices:Invoice[];notes:string;referenceSnapshot?:Item[];useCurrentReference?:boolean;linkedSapCodes?:string[];soldierLineAllocations?:Record<string,Record<string,number>>;soldierLineTotals?:Record<string,number>;soldierManualLineKeys?:string[]};
export function digits(v:string){return v.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))}
export function numeric(v:unknown):number|null{const s=digits(String(v??'')).trim().replace(/٬/g,',').replace(/٫/g,'.');if(!s)return null;if(!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s))return null;const n=Number(s.replace(/,/g,''));return Number.isFinite(n)?n:null}
export function fils(v:string):number|null{
 const amount=digits(v).trim().replace(/^(\d+),(\d{1,2})$/,'$1.$2').replace(/^(\d+)،(\d{1,3})$/,'$1.$2');
 const n=numeric(amount);if(n===null||n<0||n>100000000||Math.abs(n*1000-Math.round(n*1000))>0.00001)return null;return Math.round(n*1000)}
export const money=(n:number|null)=>n===null?'—':(n/1000).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
export const num=(n:number|null)=>n===null?'—':String(Number(n.toFixed(6)));
const header=(s:string)=>s.toLowerCase().replace(/[\s._\-:]/g,'');
const wh=(s:string)=>/^\d+$/.test(digits(s.trim()))?digits(s.trim()).padStart(3,'0'):s.trim();
export function parseTransfer(paste:string,{allowReverse=false}={}){const lines:TransferLine[]=[],issues:string[]=[],excluded:string[]=[];const raw=paste.replace(/\r/g,'').split('\n');const h=raw.findIndex(l=>l.split('\t').some(c=>['itemno','itemcode'].includes(header(c))));if(h<0)return {lines,issues:paste.trim()?['لم أجد عناوين SAP. انسخ الجدول مع سطر العناوين، بما فيه Item No. وQuantity وUoM.']:[],excluded};const cols=raw[h].split('\t').map(header);const col=(options:string[])=>cols.findIndex(c=>options.includes(c));const code=col(['itemno','itemcode']),qty=col(['quantity']),unit=col(['uomname','uomcode','uom','inventoryuom']),name=col(['itemdescription','description']),from=col(['fromwarehouse','fromwhse']),to=col(['towarehouse','towhse']);if([code,qty,unit,from,to].some(i=>i<0))return {lines,issues:['الأعمدة المطلوبة: Item No.، Quantity، UoM Name أو UoM Code، From Warehouse، To Warehouse.'],excluded};
for(let i=h+1;i<raw.length;i++){if(!raw[i].trim())continue;const c=raw[i].split('\t'),sapCode=(c[code]||'').trim().toUpperCase();if(['itemno','itemcode'].includes(header(c[code]||''))&&c.some(cell=>header(cell)==='quantity'))continue;if(!sapCode){issues.push('سطر '+(i+1)+': بلا كود صنف؛ راجعه قبل الاعتماد.');continue}if(!/^[A-Z]{2,6}\d{3,10}$/.test(sapCode)){issues.push('سطر '+(i+1)+': كود غير صالح '+sapCode);continue}const f=wh(c[from]||''),t=wh(c[to]||'');if(!f||!t){issues.push('سطر '+(i+1)+': بيانات المستودعات ناقصة');continue}const reverse=allowReverse&&f==='011'&&['001','002','009'].includes(t);if(!reverse&&(!['001','002','009'].includes(f)||t!=='011')){excluded.push('سطر '+(i+1)+' '+sapCode+': '+f+' إلى '+t);continue}const quantity=numeric(c[qty]),u=(c[unit]||'').trim();if(quantity===null||quantity<0||quantity>100000000){issues.push('سطر '+(i+1)+': كمية غير صالحة');continue}if(!['piece','carton','kg'].includes(u.toLowerCase())){issues.push('سطر '+(i+1)+': وحدة غير معروفة '+u);continue}lines.push({row:i+1,sapCode,name:c[name]||'',quantity:reverse&&quantity!==0?-quantity:quantity,unit:u.toLowerCase()==='piece'?'Piece':u.toLowerCase()==='carton'?'Carton':'KG',from:f,to:t})}return {lines,issues,excluded}}
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
function parseTransfers(transfers:Transfer[]){
 const parsed={lines:[] as TransferLine[],issues:[] as string[],excluded:[] as string[]};
 for(const [index,transfer] of transfers.entries()){
  const source=parseTransfer(transfer.paste,{allowReverse:true});
  const label='الترحيل '+(transfer.number||index+1)+': ';
  parsed.lines.push(...source.lines.map(line=>({...line,transferNo:transfer.number})));
  parsed.issues.push(...source.issues.map(issue=>label+issue));
  parsed.excluded.push(...source.excluded.map(issue=>label+issue));
 }
 return parsed;
}

function completeReference(snapshot:Item[],current:Item[],lines:TransferLine[],excludedItems:Set<string>){
 const used=new Set(lines.map(line=>line.sapCode));
 const historicalOwners=new Map(sapReferences(snapshot).map(item=>[item.sapCode,item.code]));
 const items=new Map(snapshot.map(item=>[item.code,item]));
 let updated=false;
 for(const item of current){
  if(!item.active||excludedItems.has(item.code))continue;
  const compatible=[item,...(item.sapAliases||[])].filter(({sapCode})=>
   !historicalOwners.has(sapCode)||historicalOwners.get(sapCode)===item.code);
  if(!compatible.some(link=>used.has(link.sapCode)))continue;
  const stored=items.get(item.code);
  if(!stored?.active){
   const [primary,...sapAliases]=compatible.map(({sapCode,sapUnit,cartonPieces,kgPerPiece})=>({sapCode,sapUnit,cartonPieces,kgPerPiece}));
   items.set(item.code,{...item,...primary,sapAliases});
   updated=true;
   continue;
  }
  const links=new Map([stored,...(stored.sapAliases||[])].map(link=>[link.sapCode,link]));
  const price=stored.price??item.price;
  let changed=price!==stored.price;
  for(const link of compatible){
   if(!used.has(link.sapCode))continue;
   const {sapCode,sapUnit,cartonPieces,kgPerPiece}=link;
   const previous=links.get(sapCode);
   const carton=previous?.cartonPieces??cartonPieces,weight=previous?.kgPerPiece??kgPerPiece;
   if(previous&&previous.cartonPieces===carton&&previous.kgPerPiece===weight)continue;
   links.set(sapCode,{sapCode,sapUnit:previous?.sapUnit??sapUnit,cartonPieces:carton,kgPerPiece:weight});
   changed=true;
  }
  if(changed){
   const [primary,...sapAliases]=links.values();
   items.set(item.code,{...stored,...primary,price,sapAliases});
   updated=true;
  }
 }
 return updated?[...items.values()]:snapshot;
}

function retainedUnlinkedExclusions(draft:Draft,lines:TransferLine[]){
 const bySap=new Map<string,TransferLine[]>();
 if(draft.mode==='manual'&&draft.excludedItems){
  for(const line of lines){
   if(!draft.excludedItems['s:'+line.sapCode])continue;
   const details=bySap.get(line.sapCode)||[];
   details.push(line);
   bySap.set(line.sapCode,details);
  }
 }
 return new Set([...bySap].filter(([sapCode,details])=>
  draft.excludedItems?.['s:'+sapCode]===checkSignature({name:details[0].name,unitPrice:null,transfer:null,details}))
  .map(([sapCode])=>sapCode));
}

function moveApprovedPages<T extends Draft>(draft:T,reference:Item[],excludedSapCodes:Set<string>):T{
 let {pages,pageEntryOrder}=draft;
 const keys=new Set([...(pageEntryOrder||[]),...Object.keys(pages||{})]);
 const unlinked=[...keys].filter(key=>key.startsWith('s:'));
 if(!unlinked.length)return draft;
 const bySap=new Map(sapReferences(reference.filter(item=>item.active)).map(item=>[item.sapCode,item.code]));
 for(const source of unlinked){
  const sapCode=source.slice(2);
  const code=bySap.get(sapCode);
  if(!code||excludedSapCodes.has(sapCode))continue;
  const target='i:'+code;
  const moveOrder=pageNumber(pages?.[target])===0;
  pages=moveLinkedPage(pages,sapCode,code);
  pageEntryOrder=pageEntryOrder?.flatMap(key=>key===source?(moveOrder?[target]:[]):[key]);
 }
 return pages===draft.pages?draft:{...draft,pages,pageEntryOrder};
}

export function prepareReconciliation<T extends Draft>(draft:T,current:Item[]){
 const parsed=parseTransfers(draft.transfers);
 const excludedSapCodes=retainedUnlinkedExclusions(draft,parsed.lines);
 const snapshot=draft.useCurrentReference?undefined:draft.referenceSnapshot;
 let reference=current;
 if(snapshot){
  const historical=draft.linkedSapCodes?.length?groupReference(snapshot,current,draft.linkedSapCodes):snapshot;
  // Keep recorded prices and conversions, and preserve valid manual exclusions on saved rows.
  const excludedItems=new Set<string>();
  if(draft.mode==='manual'&&Object.keys(draft.excludedItems||{}).some(key=>key.startsWith('i:'))){
   for(const row of reconcileManual(draft,historical,parsed,excludedSapCodes).excludedRows){
    if(row.item)excludedItems.add(row.code);
   }
  }
  reference=completeReference(historical,current,parsed.lines,excludedItems);
 }
 const prepared=moveApprovedPages(draft,reference,excludedSapCodes);
 const result=prepared.mode==='manual'
  ?reconcileManual(prepared,reference,parsed,excludedSapCodes)
  :reconcileLegacy(prepared,reference,parsed);
 return {draft:prepared,reference,result};
}

export function reconcile(d:Draft,reference:Item[]){
 const parsed=parseTransfers(d.transfers);
 return d.mode==='manual'?reconcileManual(d,reference,parsed,retainedUnlinkedExclusions(d,parsed.lines)):reconcileLegacy(d,reference,parsed);
}
function reconcileLegacy(d:Draft,reference:Item[],parsed:ReturnType<typeof parseTransfers>,excludedSapCodes=new Set<string>()){const active=reference.filter(i=>i.active),bySap=new Map(sapReferences(active).filter(i=>!excludedSapCodes.has(i.sapCode)).map(i=>[i.sapCode,i])),byCode=new Map(active.map(i=>[i.code,i]));const problems=[...parsed.issues];const transferNos=d.transfers.map(t=>documentNo(t.number));if(transferNos.some(n=>!n))problems.push('أكمل أرقام الترحيلات');if(new Set(transferNos).size!==transferNos.length)problems.push('رقم ترحيل مكرر داخل المجموعة');if(!d.transfers.length)problems.push('أضف ترحيلًا واحدًا على الأقل');if(!parsed.lines.length)problems.push('أضف ترحيل SAP صالحًا للمطابقة');if(!d.invoices.length)problems.push('أضف فاتورة مؤسسة واحدة على الأقل');const numbers=d.invoices.map(i=>invoiceDocumentNo(i.number));if(numbers.some(n=>!n))problems.push('أكمل أرقام الفواتير');if(new Set(numbers).size!==numbers.length)problems.push('رقم فاتورة مكرر داخل المجموعة');if(d.invoices.some(i=>!i.complete))problems.push('أكّد اكتمال بنود كل فاتورة بعد إدخالها');if(d.invoices.some(i=>fils(i.amount)===null))problems.push('أكمل مبلغ كل فاتورة بدقة حتى 3 منازل');
const rows=new Map<string,{key:string;item:Item|null;sapCode:string;code:string;name:string;transfer:number|null;invoice:number;details:TransferLine[];errors:string[];perInvoice:(number|null)[];unitPrice:number|null;expected:number|null;difference:number|null;state:string}>();
const ensure=(key:string,item:Item|null,sapCode:string,code:string,name:string)=>{if(!rows.has(key))rows.set(key,{key,item,sapCode,code,name,transfer:0,invoice:0,details:[],errors:[],perInvoice:d.invoices.map(()=>0),unitPrice:item?.price??null,expected:null,difference:null,state:''});return rows.get(key)!};
for(const l of parsed.lines){const item=bySap.get(l.sapCode)||null;const r=ensure(item?'i:'+item.code:'s:'+l.sapCode,item,l.sapCode,item?.code||'',item?.name||l.name);r.details.push(l);if(!item){r.transfer=null;if(!r.errors.includes('كود SAP غير مربوط بصنف مؤسسة معتمد'))r.errors.push('كود SAP غير مربوط بصنف مؤسسة معتمد');continue}try{const q=convert(l,item);if(r.transfer!==null)r.transfer+=q}catch(e:any){r.transfer=null;r.errors.push(e.message)}}
for(const [j,inv] of d.invoices.entries())for(const [code,value] of Object.entries(inv.quantities)){if(!String(value).trim())continue;const item=byCode.get(code)||null;const r=ensure('i:'+code,item,item?.sapCode||'',code,item?.name||'رقم مؤسسة غير معرّف');if(!item)r.errors.push('رقم المؤسسة غير معرّف في القائمة المعتمدة');const q=numeric(value);if(q===null||q<0||q>100000000){r.perInvoice[j]=null;r.errors.push('كمية الفاتورة '+(j+1)+' غير صالحة')}else{r.perInvoice[j]=q;r.invoice+=q}}
for(const r of rows.values()){r.difference=r.transfer===null?null:Number((r.invoice-r.transfer).toFixed(6));r.expected=r.transfer===null||r.unitPrice===null?null:Math.round(r.transfer*r.unitPrice);r.state=r.errors.length?'review':r.difference===0?'match':r.transfer===0&&r.invoice>0?'invoiceOnly':r.invoice===0&&(r.transfer||0)>0?'transferOnly':'difference'}
const result=[...rows.values()];const review=result.filter(r=>r.state==='review').length,differences=result.filter(r=>!['match','review'].includes(r.state)).length;const total=filsSum(d.invoices.map(i=>i.amount));const expected=result.length&&result.every(r=>r.expected!==null)?result.reduce((s,r)=>s+r.expected!,0):null;const invoiceCalculated=d.invoices.map((inv,j)=>result.every(r=>r.perInvoice[j]===0||r.perInvoice[j]!==null&&r.unitPrice!==null)?result.reduce((s,r)=>s+Math.round((r.perInvoice[j]||0)*(r.unitPrice||0)),0):null);const invoiceAmountDiffs=invoiceCalculated.map((v,j)=>v===null||fils(d.invoices[j].amount)===null?null:fils(d.invoices[j].amount)!-v);const priceDifference=total===null||expected===null?null:total-expected;const status=problems.length||review?'review':differences?'difference':priceDifference===null?'quantityMatch':priceDifference!==0||invoiceAmountDiffs.some(v=>v!==null&&v!==0)?'difference':'match';return {parsed,rows:result,problems,review,differences,total,expected,priceDifference,invoiceCalculated,invoiceAmountDiffs,status}}
function filsSum(values:string[]){const n=values.map(fils);return n.some(v=>v===null)?null:n.reduce<number>((s,v)=>s+v!,0)}
export const labels:Record<string,string>={review:'بحاجة مراجعة',difference:'يوجد فرق',match:'مطابق',quantityMatch:'الكميات مطابقة؛ الأسعار ناقصة',invoiceOnly:'في الفواتير فقط',transferOnly:'في الترحيل فقط'};

export function documentNo(s:string){return digits(s).trim().replace(/,/g,'').replace(/\s+/g,' ')}
export function invoiceDocumentNo(value: unknown) {
 const number = documentNo(String(value ?? ''));
 return /^0+$/.test(number) ? '' : number;
}
export function matchesInvoiceNumbers(invoices:Invoice[],numbers:string[]):boolean{
 const openNumbers=new Set(invoices.map(invoice=>invoiceDocumentNo(invoice.number)).filter(Boolean));
 return numbers.length===openNumbers.size&&numbers.every(number=>openNumbers.has(number));
}
export function dateValue(s:string,format='dmy'):string|null{const n=digits(String(s)).trim().split(' ')[0];let m=n.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);let y,mo,day;if(m){y=+m[1];mo=+m[2];day=+m[3]}else{m=n.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);if(!m)return null;y=+m[3];mo=+(format==='mdy'?m[1]:m[2]);day=+(format==='mdy'?m[2]:m[1])}const d=new Date(Date.UTC(y,mo-1,day));if(d.getUTCFullYear()!==y||d.getUTCMonth()!==mo-1||d.getUTCDate()!==day)return null;return `${y}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`}
function outgoingTransferDates(transfers: Transfer[]) {
 return transfers.flatMap(transfer=>{
  const date=dateValue(transfer.date);
  if(!date||!parseTransfer(transfer.paste).lines.length)return [];
  return [{number:documentNo(transfer.number),date}];
 }).sort((a,b)=>a.date.localeCompare(b.date));
}
export function withInvoiceDates<T extends Draft>(draft:T):T {
 const outgoing = outgoingTransferDates(draft.transfers);
 return {...draft,invoices:draft.invoices.map(invoice=>{
  if(invoice.manualDate===true)return invoice; // Never overwrite an explicitly manual date, even if it needs correction.
  const linked=Array.isArray(invoice.dateTransferNos)&&outgoing.find(transfer=>invoice.dateTransferNos!.includes(transfer.number));
  const source=linked||outgoing[0];
  if(!source)return invoice;
  const date=new Date(source.date+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()-1);
  return {...invoice,date:date.toISOString().slice(0,10)};
 })};
}
export function editInvoiceDate(invoices:Invoice[],id:string,date:string):Invoice[]{
 return invoices.map(invoice=>date||invoice.id===id?{...invoice,date,manualDate:!!date}:invoice);
}
export function addTransferToDraft<T extends Draft>(draft: T, transfer: Transfer, branch: string, replaceId?: string): T {
 const originalDates = outgoingTransferDates(draft.transfers.filter(row => row.id !== replaceId));
 const invoices = draft.invoices.map(invoice => {
  if (!originalDates.length || !invoiceDocumentNo(invoice.number) || invoice.manualDate ||
      originalDates.some(row => invoice.dateTransferNos?.includes(row.number))) return invoice;
  return {...invoice, dateTransferNos: [originalDates[0].number]};
 });
 const transfers = replaceId
  ? draft.transfers.map(row => row.id === replaceId ? {...transfer, id: replaceId} : row)
  : [...draft.transfers, transfer];
 return withInvoiceDates({...draft, branch: draft.branch || branch, invoices, transfers});
}
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
 const result={missing:[] as any[],received:[] as any[],pending:[] as any[],outside:[] as any[],extra:[] as any[],canceled:[] as any[],toCancel:[] as any[],reverse:[] as any[],problems:[] as string[],duplicates:[] as string[]};
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
  const complete=Boolean(draft.invoices?.length)&&draft.invoices.every((invoice:Invoice)=>invoiceDocumentNo(invoice.number)&&invoice.complete);
  for(const transfer of draft.transfers||[]){
   for(const number of transferNumbers(transfer.number||'')){
    if(!saved.has(number))saved.set(number,{group,date:dateValue(transfer.date||''),complete});
   }
  }
 }
 const headers=plainNumbers?[]:serialHeaders(paste).map(header);
 const col=(names:string[])=>headers.findIndex(h=>names.includes(h));
 const fromCol=col(['fromwarehouse','منمستودع','المستودعالمصدر']);
 const toCol=col(['towarehousecode','towarehouse','إلىمستودع','المستودعالهدف']);
 const detailCol=col(['details','تفاصيل','التفاصيل']);
 const remarksCol=col(['remarks','ملاحظات']);
 const sourceRows=lines.slice(plainNumbers?0:1).map(line=>line.split('\t'));
 const canceledBy=new Map<string,string>();
 for(const cells of sourceRows){
  const number=transferNumbers(cells[plainNumbers?0:columns.number]||'')[0];
  const details=[detailCol,remarksCol].filter(index=>index>=0).map(index=>cells[index]||'').join(' ');
  const original=details.match(/inventory\s+transfer\s+no\.?\s*(\d+)\s+has\s+been\s+canceled/i)?.[1];
  if(original&&number)canceledBy.set(original,number);
 }
 const cashVan=/(?:كاش\s*فان|كاش\s*فإن|كاش\s*ڤان|cash[\s-]*van)/i;
 const institution=/المؤسسة\s*الاستهلاكية\s*العسكرية|مستودع\s*المؤسسة|\b011\b/i;
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
  const details=[detailCol,remarksCol].filter(index=>index>=0).map(index=>cells[index]||'').join(' ');
  const from=fromCol>=0?cells[fromCol]||'':'';
  const to=toCol>=0?cells[toCol]||'':'';
  const cancelMatch=details.match(/inventory\s+transfer\s+no\.?\s*(\d+)\s+has\s+been\s+canceled/i);
  if(cancelMatch||canceledBy.has(number)){
   result.canceled.push({...row,reason:cancelMatch?'حركة إلغاء للترحيل '+cancelMatch[1]:'أُلغي بحركة رقم '+canceledBy.get(number),group:entry?.group});
   continue;
  }
  if(cashVan.test(details)||cashVan.test(row.branch)){
   result.toCancel.push({...row,reason:'كاش فان — مطلوب التحقق والإلغاء على SAP',group:entry?.group});
   continue;
  }
  if(fromCol>=0&&toCol>=0&&institution.test(from)&&!institution.test(to)){
   result.reverse.push({...row,reason:'ترحيل عكسي من المؤسسة إلى '+to,group:entry?.group});
   continue;
  }
  if(!entry){
   result.missing.push(row);
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
function reconcileManual(d:Draft,reference:Item[],parsed:ReturnType<typeof parseTransfers>,excludedSapCodes:Set<string>){
 const base=reconcileLegacy({...d,mode:undefined,invoices:d.invoices.map(i=>({...i,complete:true,quantities:{}}))},reference,parsed,excludedSapCodes);
 const problems=base.problems.filter(p=>!p.includes('اكتمال بنود'));
 if(d.invoices.some(i=>!i.complete))problems.push('أكد وجود كل فاتورة ورقية للمجموعة');
 const excludedRows=base.rows.filter(r=>d.excludedItems?.[r.key]===checkSignature(r));
 const included=base.rows.filter(r=>d.excludedItems?.[r.key]!==checkSignature(r));
 const rows=included.map(r=>{const c=d.checks?.[r.key],valid=c?.signature===checkSignature(r);const state=r.errors.length?'review':'match';return {...r,invoice:0,difference:null,state}});
 const expected=base.rows.length&&rows.every(r=>r.expected!==null)?rows.reduce((sum,r)=>sum+r.expected!,0):null;
 const priceDifference=base.total===null||expected===null?null:base.total-expected;
 const unchecked=0,review=rows.filter(r=>r.state==='review').length,differences=0;
 for(const r of rows){const page=d.pages?.[r.key];if(page&&(!/^\d+$/.test(digits(page))||pageNumber(page)>d.invoices.length))problems.push('رقم الفاتورة الزرقاء للصنف '+(r.code||r.sapCode)+' غير موجود في الفواتير المسجلة');}
 const status=review||problems.length?'review':differences||priceDifference!==null&&priceDifference!==0?'difference':priceDifference===null?'priceMissing':'match';
 const acceptedDifference=status==='difference'&&base.total!==null&&expected!==null
  &&d.acceptedDifference?.paper===base.total&&d.acceptedDifference.calculated===expected;
 return {...base,rows,excludedRows,expected,priceDifference,problems,review:review+unchecked,differences,status:acceptedDifference?'match':status,acceptedDifference,invoiceCalculated:d.invoices.map(()=>null),invoiceAmountDiffs:d.invoices.map(()=>null)};
}
labels.unchecked='لم يُشيّك';labels.priceMissing='التشييك مكتمل؛ الأسعار ناقصة';
