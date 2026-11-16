import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {digits,dateValue as invoiceDateValue,fils} from './reconcile';
import {PROJECT_ONLY_NOTE,serialMergeProposals,serialInvoiceColumns,serialReviewNote,serialWorkingDays,auditSerialExport,type SerialInput,type SerialReport,type SerialState,type SerialPeriod} from './serial-soldier';

const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_FILE=12*1024*1024;
const MAX_UNPACKED=50*1024*1024;
type Archive=Record<string,Uint8Array>;
type Package={files:Archive; doc:Document; name:string; shared:string[]};
const find=(root:Element|Document,tag:string)=>root.getElementsByTagNameNS(NS,tag)[0]||null;
const children=(root:Element,tag:string)=>Array.from(root.children).filter(e=>e.localName===tag&&e.namespaceURI===NS);
const cellColumn=(r:string)=>{let n=0;for(const c of r.match(/^[A-Z]+/)?.[0]||'')n=n*26+c.charCodeAt(0)-64;return n;};
const columnName=(n:number)=>{let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;};
function readXml(bytes:Uint8Array):Document{
 const doc=new DOMParser().parseFromString(strFromU8(bytes),'application/xml');
 if(doc.getElementsByTagName('parsererror').length)throw Error('تنسيق XML داخل ملف Excel تالف.');
 return doc;
}
function load(bytes:Uint8Array):Package{
 if(bytes.length>MAX_FILE)throw Error('ملف Excel أكبر من الحد المسموح (12 MB).');
 let files:Archive;
 try{files=unzipSync(bytes);}catch{throw Error('تعذر فتح ملف Excel. يجب أن يكون XLSX أصليًا.');}
 if(Object.values(files).reduce((total,v)=>total+v.length,0)>MAX_UNPACKED)throw Error('ملف Excel كبير جدًا بعد فك الضغط.');
 if(!files['xl/workbook.xml']||!files['xl/_rels/workbook.xml.rels'])throw Error('هذا الملف ليس دفتر Excel صالحًا.');
 const book=readXml(files['xl/workbook.xml']);
 const sheet=Array.from(book.getElementsByTagNameNS(NS,'sheet')).find(e=>e.getAttribute('name')==='للطباعة');
 if(!sheet)throw Error('لم أجد الشيت «للطباعة» في ملف سجى. لا يتم التخمين من شيت آخر.');
 const id=sheet.getAttributeNS(REL,'id')||sheet.getAttribute('r:id');
 const relationships=readXml(files['xl/_rels/workbook.xml.rels']);
 const link=Array.from(relationships.documentElement.children).find(el=>el.getAttribute('Id')===id);
 if(!link)throw Error('تعذر تحديد ملف الشيت «للطباعة».');
 const target=link.getAttribute('Target')||'';
 const name=target.startsWith('/')?target.slice(1):target.startsWith('xl/')?target:'xl/'+target.replace(/^(\.\/)+/,'');
 if(!files[name])throw Error('ملف شيت «للطباعة» مفقود من Excel.');
 const shared:string[]=[];
 if(files['xl/sharedStrings.xml']){
  const strings=readXml(files['xl/sharedStrings.xml']);
  for(const si of strings.getElementsByTagNameNS(NS,'si')){
   shared.push(Array.from(si.getElementsByTagNameNS(NS,'t')).map(t=>t.textContent||'').join(''));
  }
 }
 return {files,doc:readXml(files[name]),name,shared};
}
function getCell(row:Element,ref:string){
 return children(row,'c').find(c=>c.getAttribute('r')===ref);
}
function value(cell:Element|undefined,shared:string[]){
 if(!cell)return '';
 if(cell.getAttribute('t')==='inlineStr')return Array.from(cell.getElementsByTagNameNS(NS,'t')).map(n=>n.textContent||'').join('');
 const v=find(cell,'v')?.textContent||'';
 if(cell.getAttribute('t')==='s')return shared[Number(v)]??'';
 return v;
}
function text(cell:Element|undefined,shared:string[]){return value(cell,shared).trim();}
function dateValue(raw:string) {
 const n=Number(raw);
 if(raw&&Number.isFinite(n)&&n>20000&&n<100000){
  return new Date(Date.UTC(1899,11,30)+Math.round(n)*86400000).toISOString().slice(0,10);
 }
 return invoiceDateValue(raw)||raw;
}
function rowsFrom(p:Package):{rows:SerialInput[]; errors:string[];period:SerialPeriod|null}{
 const d=p.doc,errors:string[]=[];
 const data=find(d,'sheetData');
 if(!data)throw Error('لا توجد بيانات في شيت «للطباعة».');
 const rowList=children(data,'row');
 const head=rowList.find(r=>r.getAttribute('r')==='4');
 const title=rowList.find(r=>r.getAttribute('r')==='3');
 if(!head||!title||!text(getCell(head,'D4'),p.shared).includes('رقم الفاتورة')||
    !text(getCell(head,'F4'),p.shared).includes('قيمة الفاتورة')||
    !text(getCell(title,'K3'),p.shared).includes('رئيسي')||
    !text(getCell(title,'L3'),p.shared).includes('نواشف'))
   throw Error('أعمدة ملف سجى لا تطابق القالب المعتمد: D رقم الفاتورة، F قيمتها، K رئيسي، L نواشف.');
 const result:SerialInput[]=[];
 const noteColumns=[...children(head,'c'),...children(title,'c')]
  .filter(cell=>/(?:ملاحظ(?:ة|ات)?|remarks?|notes?)/i.test(text(cell,p.shared)))
  .map(cell=>cellColumn(cell.getAttribute('r')||''));
 for(const row of rowList){
  const index=Number(row.getAttribute('r'));
  if(index<5||!Number.isInteger(index))continue;
  const invoice=text(getCell(row,'D'+index),p.shared);
  const amount=text(getCell(row,'F'+index),p.shared);
  const serial=text(getCell(row,'B'+index),p.shared);
  if(!invoice && !(amount&&/^\d+$/.test(serial)))continue;
  const number=digits(invoice).replace(/\s/g,'');
  if(!/^\d{8,20}$/.test(number))errors.push('صف '+index+': رقم فاتورة مفقود أو غير صالح ('+(invoice||'فارغ')+').');
  if(!amount)errors.push('صف '+index+': مبلغ الفاتورة '+(number||'غير معروف')+' مفقود.');
  const originalTransfers=Array.from({length:7},(_,i)=>text(getCell(row,columnName(11+i)+index),p.shared))
    .flatMap(raw=>raw.match(/\d{4,20}/g)||[]);
  const projectOnly=noteColumns.some(col=>text(getCell(row,columnName(col)+index),p.shared).includes(PROJECT_ONLY_NOTE));
  result.push({row:index,number,amount,date:dateValue(text(getCell(row,'C'+index),p.shared)),workbookBranch:text(getCell(row,'E'+index),p.shared),originalTransfers,
   ...(projectOnly?{origin:'project' as const}:{})});
 }
 if(!result.length)errors.push('لم أعثر على أي فواتير صالحة في الشيت.');
 // Saja's heading declares the reporting period even when some days have no rows.
 const heading=digits(text(getCell(title,'B3'),p.shared));
 const headingDates=(heading.match(/\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}/g)||[])
  .map(raw=>invoiceDateValue(raw.replace(/\./g,'/'))).filter((date):date is string=>!!date);
 const rowDates=result.map(row=>invoiceDateValue(row.date)).filter((date):date is string=>!!date).sort();
 const period=headingDates.length===2&&headingDates[0]<=headingDates[1]?
  {from:headingDates[0],to:headingDates[1]}:
  rowDates.length?{from:rowDates[0],to:rowDates[rowDates.length-1]}:null;
 return {rows:result,errors,period};
}
export function readSerialWorkbook(input:ArrayBuffer) {
 const pkg=load(new Uint8Array(input));
 return rowsFrom(pkg);
}
function element(doc:Document,tag:string){return doc.createElementNS(NS,tag);}
function setText(doc:Document,el:Element,value:string){
 while(el.firstChild)el.removeChild(el.firstChild);
 el.appendChild(doc.createTextNode(value));
}
function ensureCell(doc:Document,row:Element,col:number,rowNo:number){
 const ref=columnName(col)+rowNo;
 const existing=getCell(row,ref);if(existing)return existing;
 const c=element(doc,'c');c.setAttribute('r',ref);
 const later=children(row,'c').find(cell=>cellColumn(cell.getAttribute('r')||'')>col);
 if(later)row.insertBefore(c,later);else row.appendChild(c);
 return c;
}
function ensureStyles(files:Archive){
 if(!files['xl/styles.xml'])throw Error('ملف الأنماط الأصلي مفقود؛ لن أعدّل التصميم.');
 const doc=readXml(files['xl/styles.xml']);
 const fills=find(doc,'fills'),xfs=find(doc,'cellXfs');
 if(!fills||!xfs)throw Error('أنماط Excel الأصلية غير مكتملة.');
 const palette:Record<SerialState|'project_only',string>={received:'FFD8F3DC',received_difference:'FFFFF0BF',pending:'FFFAD5E5',missing:'FFFAD5E5',review:'FFFFF0BF',project_only:'FFCCE5FF'};
 const fillsByState=new Map<SerialState|'project_only',number>();
 for(const [state,color] of Object.entries(palette) as [SerialState|'project_only',string][]){
  if(state==='missing'){fillsByState.set(state,fillsByState.get('pending')!);continue;}
  const index=children(fills,'fill').length;
  const fill=element(doc,'fill'),pattern=element(doc,'patternFill'),fg=element(doc,'fgColor'),bg=element(doc,'bgColor');
  pattern.setAttribute('patternType','solid');fg.setAttribute('rgb',color);bg.setAttribute('indexed','64');
  pattern.appendChild(fg);pattern.appendChild(bg);fill.appendChild(pattern);fills.appendChild(fill);
  fillsByState.set(state,index);
 }
 fills.setAttribute('count',String(children(fills,'fill').length));
 const cache=new Map<string,string>();
 return {doc,apply:(style:string|null,state:SerialState|'project_only')=>{
   const original=style&&/^\d+$/.test(style)?Number(style):0;
   const key=original+'-'+state;
   if(cache.has(key))return cache.get(key)!;
   const base=children(xfs,'xf')[original];
   if(!base)throw Error('تعذر نسخ نمط خلية '+original+' من الملف الأصلي.');
   const newStyle=base.cloneNode(true) as Element;
   newStyle.setAttribute('fillId',String(fillsByState.get(state)));
   newStyle.setAttribute('applyFill','1');
   const index=children(xfs,'xf').length;
   xfs.appendChild(newStyle);
   xfs.setAttribute('count',String(index+1));
   cache.set(key,String(index));
   return String(index);
 }};
}
function editCell(doc:Document,cell:Element,expected:string,shared:string[]){
 const existing=value(cell,shared).trim();
 if(find(cell,'f'))throw Error('الخلية '+cell.getAttribute('r')+' فيها معادلة. ممنوع تغييرها.');
 if(existing&&existing!==expected)throw Error('الخلية '+cell.getAttribute('r')+' تحتوي رقمًا مختلفًا ('+existing+')؛ تم منع استبداله.');
 if(!expected)return;
 for(const child of [...cell.children])if(['v','is','f'].includes(child.localName))cell.removeChild(child);
 cell.setAttribute('t','inlineStr');
 const is=element(doc,'is'),t=element(doc,'t');
 t.setAttribute('xml:space','preserve');setText(doc,t,expected);is.appendChild(t);cell.appendChild(is);
}
// Keep Saja's original worksheet, numbers, amounts, sheets and print layout intact.
// Reuse the existing remarks column when present; otherwise add only ONE remarks column.
function notesColumn(rows:Map<number,Element>,pkg:Package,report:SerialReport):{column:number;added:boolean}{
 const candidates=[rows.get(4),rows.get(3)].filter((row):row is Element=>!!row)
   .flatMap(row=>children(row,'c')).filter(cell=>/(?:ملاحظ(?:ة|ات)?|remarks?|notes?)/i.test(text(cell,pkg.shared)));
 for(const cell of candidates){
  const col=cellColumn(cell.getAttribute('r')||'');
  if(col&&report.rows.every(item=>!find(getCell(rows.get(item.row)!,columnName(col)+item.row)??cell,'f')))
    return {column:col,added:false};
 }
 const existing=[rows.get(3),rows.get(4),...report.rows.map(item=>rows.get(item.row))]
   .filter((row):row is Element=>!!row).flatMap(row=>children(row,'c'))
   .map(cell=>cellColumn(cell.getAttribute('r')||''));
 return {column:Math.max(17,...existing)+1,added:true};
}
function overwriteText(doc:Document,cell:Element,value:string){
 if(find(cell,'f'))throw Error('توجد معادلة في خلية الملاحظات '+cell.getAttribute('r')+'؛ لا يجوز استبدالها.');
 for(const part of [...cell.children])if(['v','is'].includes(part.localName))cell.removeChild(part);
 cell.setAttribute('t','inlineStr');
 const inline=element(doc,'is'),textNode=element(doc,'t');
 textNode.setAttribute('xml:space','preserve');
 setText(doc,textNode,value);inline.appendChild(textNode);cell.appendChild(inline);
}
function writeNumber(doc:Document,cell:Element,value:number){
 if(find(cell,'f'))throw Error('لا يمكن استبدال معادلة في صف الإضافة.');
 for(const part of [...cell.children])if(['v','is'].includes(part.localName))cell.removeChild(part);
 cell.removeAttribute('t');
 const number=element(doc,'v');setText(doc,number,String(value));cell.appendChild(number);
}
// Generated blue rows retain their project origin when this workbook is uploaded again.

/** A daily worksheet is an exact clone of the source formatting and headers.
 * Invoices move as WHOLE rows, including K:Q and the remarks column.
 */
function splitIntoDailySheets(pkg:Package,allRows:SerialReport['rows'],period:SerialPeriod|null,lastColumn:number){
 const days=serialWorkingDays(period,allRows.map(row=>row.date));
 if(!days.length)throw Error('لا يوجد يوم عمل في فترة كشف سجى.');
 const data=find(pkg.doc,'sheetData')!;
 const source=new Map(children(data,'row').map(row=>[Number(row.getAttribute('r')),row]));
 const grouped=new Map<string,typeof allRows>();
 const audit=allRows.map(item=>{
  const current=source.get(item.row);
  if(!current)throw Error('صف الفاتورة '+item.number+' غير موجود.');
  const transfers:string[]=[];
  for(let col=11;col<=17;col++){
   const raw=text(getCell(current,columnName(col)+item.row),pkg.shared);
   if(raw&&!/^\s*\d{4,20}(?:\s*[,،]\s*\d{4,20})*\s*$/.test(raw))
    throw Error('فاتورة '+item.number+': خانة الترحيل '+columnName(col)+' غير صالحة.');
   transfers.push(...(raw.match(/\d{4,20}/g)||[]));
  }
  const date=invoiceDateValue(item.date);
  if(!date||!days.includes(date))throw Error('فاتورة '+item.number+': تاريخ خارج أيام العمل.');
  grouped.set(date,[...(grouped.get(date)||[]),item]);
  return {number:item.number,date:item.date,groupId:item.groupId,transfers,
   confirmedTransfers:serialInvoiceColumns(item).filter(Boolean)};
 });
 auditSerialExport(audit);
 const book=readXml(pkg.files['xl/workbook.xml']);
 const sheet=Array.from(book.getElementsByTagNameNS(NS,'sheet')).find(el=>el.getAttribute('name')==='للطباعة');
 if(!sheet)throw Error('شيت سجى الأصلي غير موجود.');
 const rels=readXml(pkg.files['xl/_rels/workbook.xml.rels']);
 const types=readXml(pkg.files['[Content_Types].xml']);
 const relRoot=rels.documentElement,typeRoot=types.documentElement;
 const sheetList=Array.from(book.getElementsByTagNameNS(NS,'sheet'));
 let sheetId=Math.max(...sheetList.map(el=>Number(el.getAttribute('sheetId'))||0))+1;
 const sheetIndex=sheetList.indexOf(sheet);
 const knownNames=new Set(sheetList.map(el=>el.getAttribute('name')));
 const knownIds=new Set(Array.from(relRoot.children).map(el=>el.getAttribute('Id')));
 const templateDoc=pkg.doc.cloneNode(true) as Document;
 const templateBody=find(templateDoc,'sheetData')!;
 for(const row of children(templateBody,'row'))if(Number(row.getAttribute('r'))>4)templateBody.removeChild(row);
 let previous=sheet;
 for(const [i,day] of days.entries()){
  const name=day.slice(8)+'-'+day.slice(5,7)+'-'+day.slice(0,4);
  if(knownNames.has(name))throw Error('شيت يوم '+name+' موجود مسبقًا في الملف.');
  knownNames.add(name);
  const daily=templateDoc.cloneNode(true) as Document,body=find(daily,'sheetData')!;
  const list=grouped.get(day)||[];
  for(const [j,item] of list.entries()){
   const original=source.get(item.row)!;
   if(original.getElementsByTagNameNS(NS,'f').length)
    throw Error('فاتورة '+item.number+' فيها معادلات؛ ممنوع نقلها دون مراجعة.');
   const copy=original.cloneNode(true) as Element,no=j+5;
   copy.setAttribute('r',String(no));
   for(const cell of children(copy,'c'))cell.setAttribute('r',columnName(cellColumn(cell.getAttribute('r')||''))+no);
   writeNumber(daily,ensureCell(daily,copy,2,no),j+1);
   body.appendChild(copy);
  }
  const heading=children(body,'row').find(row=>row.getAttribute('r')==='3');
  if(heading)overwriteText(daily,ensureCell(daily,heading,2,3),
   'استلامات المؤسسة الاستهلاكية العسكرية يوم '+name);
  const summary=children(body,'row').find(row=>row.getAttribute('r')==='2');
  const total=summary&&getCell(summary,'G2');
  if(total&&find(total,'f')){
   setText(daily,find(total,'f')!,'SUM(F5:F'+Math.max(5,4+list.length)+')');
   const v=find(total,'v');if(v)total.removeChild(v);
  }
  // The original Excel table ends at I: sorting it detaches the K:Q transfers.
  // Replace with a native whole-row autofilter through the last remarks column.
  for(const child of Array.from(daily.documentElement.children))
   if(child.namespaceURI===NS&&['tableParts','autoFilter'].includes(child.localName))
    daily.documentElement.removeChild(child);
  const filter=element(daily,'autoFilter');
  filter.setAttribute('ref','B4:'+columnName(lastColumn)+Math.max(5,4+list.length));
  const anchor=Array.from(daily.documentElement.children).find(el=>
   ['mergeCells','conditionalFormatting','dataValidations','hyperlinks','printOptions','pageMargins','pageSetup','headerFooter'].includes(el.localName));
  if(anchor)daily.documentElement.insertBefore(filter,anchor);else daily.documentElement.appendChild(filter);
  const dimension=find(daily,'dimension');
  if(dimension)dimension.setAttribute('ref','B1:'+columnName(lastColumn)+Math.max(5,4+list.length));
  for(const view of Array.from(daily.getElementsByTagNameNS(NS,'sheetView'))){
   if(i===0)view.setAttribute('tabSelected','1');else view.removeAttribute('tabSelected');
  }
  for(const kind of ['drawing','legacyDrawing','picture','oleObjects','pivotTableParts'])
   if(daily.getElementsByTagNameNS(NS,kind).length)
    throw Error('الشيت يحتوي عنصرًا مرتبطًا خارجيًا ('+kind+')؛ لا يجوز نسخه دون حماية التصميم.');
  const bytes=strToU8(new XMLSerializer().serializeToString(daily));
  if(i===0){sheet.setAttribute('name',name);pkg.files[pkg.name]=bytes;}
  else{
   const file='xl/worksheets/serial-day-'+day.replace(/-/g,'')+'.xml';
   if(pkg.files[file])throw Error('اسم شيت مكرر داخل الأرشيف.');
   pkg.files[file]=bytes;
   const newSheet=sheet.cloneNode(true) as Element;
   newSheet.setAttribute('name',name);newSheet.setAttribute('sheetId',String(sheetId++));
   let id='rSerialDay'+i;while(knownIds.has(id))id+='x';
   knownIds.add(id);newSheet.setAttributeNS(REL,'r:id',id);
   const rel=rels.createElementNS(relRoot.namespaceURI,'Relationship');
   rel.setAttribute('Id',id);
   rel.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');
   rel.setAttribute('Target','/'+file);relRoot.appendChild(rel);
   const override=types.createElementNS(typeRoot.namespaceURI,'Override');
   override.setAttribute('PartName','/'+file);
   override.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
   typeRoot.appendChild(override);
   sheet.parentNode!.insertBefore(newSheet,previous.nextSibling);previous=newSheet;
  }
 }
 const view=book.getElementsByTagNameNS(NS,'workbookView')[0];
 if(view)view.setAttribute('activeTab',String(sheetIndex));
 const first=days[0].slice(8)+'-'+days[0].slice(5,7)+'-'+days[0].slice(0,4);
 for(const named of Array.from(book.getElementsByTagNameNS(NS,'definedName')))
  if(named.textContent?.includes('للطباعة'))named.textContent=named.textContent.replace(/للطباعة/g,first);
 pkg.files['xl/workbook.xml']=strToU8(new XMLSerializer().serializeToString(book));
 pkg.files['xl/_rels/workbook.xml.rels']=strToU8(new XMLSerializer().serializeToString(rels));

 pkg.files['[Content_Types].xml']=strToU8(new XMLSerializer().serializeToString(types));
 // Independent read-back validation of the ACTUAL day-sheet XML, not merely
 // the input projection. One physical invoice and all transfers must survive.
 const seen=new Map<string,string>();
 const expected=new Map(audit.map(row=>[row.number,row]));
 for(const day of days){
  const filename=day===days[0]?pkg.name:'xl/worksheets/serial-day-'+day.replace(/-/g,'')+'.xml';
  const bytes=pkg.files[filename];
  if(!bytes)throw Error('شيت اليوم '+day+' مفقود من ملف Excel الناتج.');
  const daily=readXml(bytes),body=find(daily,'sheetData');
  if(!body)throw Error('شيت '+day+' بلا بيانات.');
  for(const line of children(body,'row')){
   const n=Number(line.getAttribute('r'));
   if(n<5)continue;
   const no=digits(text(getCell(line,'D'+n),pkg.shared)).replace(/\s/g,'');
   if(!no)continue;
   if(seen.has(no))throw Error('فشل تدقيق Excel: فاتورة '+no+' تكررت بين '+seen.get(no)+' و'+day+'.');
   seen.set(no,day);
   const original=expected.get(no);
   if(!original||original.date!==day)
    throw Error('فشل تدقيق Excel: فاتورة '+no+' ظهرت في شيت يوم غير صحيح.');
   const actual:string[]=[];
   for(let col=11;col<=17;col++)
    actual.push(...(text(getCell(line,columnName(col)+n),pkg.shared).match(/\d{4,20}/g)||[]));
   if(actual.length!==original.transfers.length||
     actual.some((transfer,i)=>transfer!==original.transfers[i]))
    throw Error('فشل تدقيق Excel: تغيّرت ترحيلات الفاتورة '+no+' بعد توزيع الأيام.');
  }
 }
 if(seen.size!==expected.size)
  throw Error('فشل تدقيق Excel: عدد الفواتير في شيتات الأيام لا يطابق المصدر ('
   +seen.size+' من '+expected.size+').');
}

export function createSerialWorkbook(input:ArrayBuffer,report:SerialReport,approvedMergeNumbers:string[]=[]):Blob {
 const pkg=load(new Uint8Array(input));
 const actual=rowsFrom(pkg);
 if(actual.rows.length!==report.rows.length||actual.rows.some((r,i)=>r.row!==report.rows[i].row||r.number!==report.rows[i].number||r.amount!==report.rows[i].amount))
  throw Error('تغيّر محتوى ملف سجى منذ المطابقة. ارفع الملف الأصلي من جديد.');
 const styles=ensureStyles(pkg.files);
 const d=pkg.doc,data=find(d,'sheetData')!;
 const rowElements=new Map(children(data,'row').map(row=>[Number(row.getAttribute('r')),row]));
 const notes=notesColumn(rowElements,pkg,report);
 const proposals=serialMergeProposals(actual.rows);
 const approved=new Set(approvedMergeNumbers);
 // Every approved number must still describe a safe merge in this exact file.
 for(const number of approved){
  const proposal=proposals.find(item=>item.number===number);
  if(!proposal||!proposal.canMerge)
   throw Error('لا يمكن دمج الفاتورة '+number+'؛ البيانات تغيّرت أو يوجد تعارض. أعد فحص الملف.');
 }
 for(const proposal of proposals)if(!approved.has(proposal.number))
  throw Error('رقم الفاتورة '+proposal.number+' مكرر؛ وافق على الدمج الآمن أو صحح التعارض قبل تنزيل الملف.');
 const discarded=new Map<number,number>();
 const removedNotes=new Map<number,number[]>();
 for(const proposal of proposals){
  if(!approved.has(proposal.number))continue;
  const keeper=rowElements.get(proposal.keepRow);
  if(!keeper)throw Error('الصف الأصلي '+proposal.keepRow+' غير متوفر للدمج.');
  for(const rowNo of proposal.removeRows){
   const row=rowElements.get(rowNo);
   if(!row)throw Error('صف الدمج '+rowNo+' غير متوفر.');
   if(row.getElementsByTagNameNS(NS,'f').length)
    throw Error('الصف '+rowNo+' يحتوي معادلات؛ لا يمكن دمجه بأمان.');
   // Validate everything before removing this copy. Do not discard distinct
   // non-transfer content or silently replace a source cell.
   const mergeTransfers:{number:string;column:number}[]=[];
   const special=new Set([2,3,4,5,6,notes.column]);
   for(const cell of children(row,'c')){
    const col=cellColumn(cell.getAttribute('r')||'');
    const raw=text(cell,pkg.shared);
    if(!raw||special.has(col))continue;
    if(col>=11&&col<=17){
     if(!/^\s*\d{4,20}(?:\s*[,،]\s*\d{4,20})*\s*$/.test(raw))
      throw Error('صف '+rowNo+': بيانات غير رقمية في خانة ترحيل؛ يحتاج مراجعة قبل الدمج.');
     mergeTransfers.push(...(raw.match(/\d{4,20}/g)||[]).map(number=>({number,column:col})));
     continue;
    }
    const retained=getCell(keeper,columnName(col)+proposal.keepRow);
    const current=text(retained,pkg.shared);
    if(current&&current!==raw)
     throw Error('صفا '+proposal.keepRow+' و'+rowNo+' فيهما بيانات مختلفة في العمود '+columnName(col)+'؛ لا يمكن دمجهما تلقائيًا.');
   }
   // Prevent difference in the source company's branch or invoice amount.
   const kBranch=text(getCell(keeper,'E'+proposal.keepRow),pkg.shared);
   const sBranch=text(getCell(row,'E'+rowNo),pkg.shared);
   const branchAlias=kBranch!==sBranch;
   if(branchAlias&&actual.rows.find(item=>item.row===rowNo)?.origin!=='project')
    throw Error('فرع الفاتورة مختلف بين صفّي '+proposal.keepRow+' و'+rowNo+'؛ لا يجوز دمج صفّي سجى مختلفين.');
   const transferSlots=new Map<string,number>();
   for(let col=11;col<=17;col++)
    for(const number of (text(getCell(keeper,columnName(col)+proposal.keepRow),pkg.shared).match(/\d{4,20}/g)||[]))
     transferSlots.set(number,col);
   for(const item of mergeTransfers){
    const originalCol=transferSlots.get(item.number);
    if(originalCol!==undefined){
     const sameCategory=(item.column>=13&&originalCol>=13)||item.column===originalCol;
     if(!sameCategory)
      throw Error('ترحيل '+item.number+' مصنف بأعمدة مختلفة بين الصفين؛ لا يمكن دمجه دون مراجعة اتجاهه.');
     continue;
    }
    if(item.column===11||item.column===12){
     const existing=getCell(keeper,columnName(item.column)+proposal.keepRow);
     if(existing&&text(existing,pkg.shared))
      throw Error('ترحيل رئيسي أو نواشف مختلف في الصفين '+proposal.keepRow+' و'+rowNo+
       '؛ لا يجوز نقل رقم الترحيل إلى عمود باتجاه مختلف.');
     if(existing&&find(existing,'f'))
      throw Error('خلية ترحيل تحتوي معادلة في الصف '+proposal.keepRow+'؛ لا يمكن تعديلها.');
     overwriteText(d,ensureCell(d,keeper,item.column,proposal.keepRow),item.number);
     transferSlots.set(item.number,item.column);
    }else{
     const free=Array.from({length:5},(_,i)=>13+i).find(col=>{
      const cell=getCell(keeper,columnName(col)+proposal.keepRow);
      return !cell||(!find(cell,'f')&&!text(cell,pkg.shared));
     });
     if(free===undefined)
      throw Error('خانات التعديلات M:Q لا تتسع لترحيل '+item.number+
       '؛ لم يتم حذف الصف المكرر حفاظًا على أرقام الترحيلات.');
     overwriteText(d,ensureCell(d,keeper,free,proposal.keepRow),item.number);
     transferSlots.set(item.number,free);
    }
   }
   for(const cell of children(row,'c')){
    const col=cellColumn(cell.getAttribute('r')||''),raw=text(cell,pkg.shared);
    if(!raw||special.has(col)||col>=11&&col<=17)continue;
    const retained=ensureCell(d,keeper,col,proposal.keepRow);
    if(!text(retained,pkg.shared))overwriteText(d,retained,raw);
   }
   const noteCell=ensureCell(d,keeper,notes.column,proposal.keepRow);
   const sourceNote=text(getCell(row,columnName(notes.column)+rowNo),pkg.shared)
    .split(' | ').filter(part=>part.trim()&&part.trim()!==PROJECT_ONLY_NOTE).join(' | ');
   const existing=text(noteCell,pkg.shared);
   const additional=['دمج مع الصف '+rowNo+' بموافقة المستخدم',
    branchAlias?'اسم الفرع في صف '+rowNo+': '+(sBranch||'غير مسجل')+'؛ فرع سجى المحتفظ به: '+(kBranch||'غير مسجل'):'',
    sourceNote&&!existing.includes(sourceNote)?sourceNote:'',
    ].filter(Boolean);
   overwriteText(d,noteCell,[existing,...additional].filter(Boolean).join(' | '));
   data.removeChild(row);rowElements.delete(rowNo);discarded.set(rowNo,proposal.keepRow);
   removedNotes.set(proposal.keepRow,[...(removedNotes.get(proposal.keepRow)||[]),rowNo]);
  }
 }
 const last=Math.max(17,notes.column);
 const allRows=report.rows.filter(item=>!discarded.has(item.row));
 const sourceRow=actual.rows.filter(item=>!discarded.has(item.row)).at(-1)?.row;
 const template=sourceRow===undefined?undefined:rowElements.get(sourceRow);
 let nextRow=Math.max(4,...actual.rows.map(row=>row.row))+1;
 let sequence=Math.max(0,...actual.rows.filter(item=>rowElements.has(item.row)).map(item=>Number(text(getCell(rowElements.get(item.row)!,'B'+item.row),pkg.shared))||0));
 const safeBlank=(row:Element)=>children(row,'c').every(cell=>{
  if(find(cell,'f'))return false;
  const col=cellColumn(cell.getAttribute('r')||'');
  return !text(cell,pkg.shared)||col===2&&/^\d+$/.test(text(cell,pkg.shared))||col===7;
 });
 for(const item of report.projectOnly||[]){
  // Prefer the existing blank invoice slots, keeping totals and all source rows intact.
  // If the template is full, append after its occupied rows instead of overwriting them.
  if(rowElements.has(nextRow)&&!safeBlank(rowElements.get(nextRow)!))
   nextRow=Math.max(...rowElements.keys())+1;
  const rowNo=nextRow++;
  let row=rowElements.get(rowNo);
  if(!row){
   row=element(d,'row');row.setAttribute('r',String(rowNo));
   if(template)for(const name of ['ht','customHeight','s','customFormat']){
    const value=template.getAttribute(name);if(value!==null)row.setAttribute(name,value);
   }
   const later=children(data,'row').find(existing=>Number(existing.getAttribute('r'))>rowNo);
   if(later)data.insertBefore(row,later);else data.appendChild(row);
   rowElements.set(rowNo,row);
  }
  for(let col=2;col<=last;col++){
   const cell=ensureCell(d,row,col,rowNo);
   const source=template&&sourceRow!==undefined?getCell(template,columnName(col)+sourceRow):undefined;
   if(source?.hasAttribute('s'))cell.setAttribute('s',source.getAttribute('s')!);
   // Keep the company's template values, without copying another invoice's data.
   if((col===7||col===8)&&!text(cell,pkg.shared)&&source&&!find(source,'f')){
    const content=text(source,pkg.shared);if(content)overwriteText(d,cell,content);
   }
  }
  writeNumber(d,ensureCell(d,row,2,rowNo),++sequence);
  const date=invoiceDateValue(item.date);
  if(date)writeNumber(d,ensureCell(d,row,3,rowNo),Math.round((Date.parse(date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000));
  overwriteText(d,ensureCell(d,row,4,rowNo),item.number);
  overwriteText(d,ensureCell(d,row,5,rowNo),item.branch);
  const amount=fils(item.omarAmount||item.amount);
  if(amount!==null)writeNumber(d,ensureCell(d,row,6,rowNo),amount/1000);
  allRows.push({...item,row:rowNo,origin:'project'});
 }
 if(notes.added){
  for(const rowNo of [3,4]){
   const row=rowElements.get(rowNo);
   if(!row)throw Error('عناوين الشيت الأصلي ناقصة.');
   const cell=ensureCell(d,row,notes.column,rowNo);
   const template=getCell(row,'Q'+rowNo)||getCell(row,'K'+rowNo);
   if(template?.getAttribute('s')&&!cell.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   overwriteText(d,cell,rowNo===3?'ملاحظات المطابقة':'الفروقات فقط');
  }
  const cols=find(d,'cols');
  if(cols){
   const col=element(d,'col');
   col.setAttribute('min',String(notes.column));
   col.setAttribute('max',String(notes.column));
   col.setAttribute('width','66');
   col.setAttribute('customWidth','1');cols.appendChild(col);
  }
  // Do not expand the print area. Saja's original printed pages remain unchanged.
  const dim=find(d,'dimension');
  if(dim){
   const ref=dim.getAttribute('ref')||'A1:Q1';
   dim.setAttribute('ref',ref.replace(/:[A-Z]+(\d+)$/,':'+columnName(notes.column)+'$1'));
  }
 }
 // Use one shared wrapping style per fill, instead of creating a style for every row.
 const wrapStyles=new Map<string,string>();
 const xfList=find(styles.doc,'cellXfs')!;
 function wrapped(style:string):string{
  if(wrapStyles.has(style))return wrapStyles.get(style)!;
  const base=children(xfList,'xf')[Number(style)];
  if(!base)throw Error('نمط ملاحظات Excel غير صالح.');
  const copy=base.cloneNode(true) as Element;
  let alignment=children(copy,'alignment')[0];
  if(!alignment){alignment=element(styles.doc,'alignment');copy.appendChild(alignment);}
  alignment.setAttribute('wrapText','1');
  alignment.setAttribute('vertical','center');
  alignment.setAttribute('horizontal','right');
  copy.setAttribute('applyAlignment','1');
  const index=children(xfList,'xf').length;
  xfList.appendChild(copy);xfList.setAttribute('count',String(index+1));
  wrapStyles.set(style,String(index));
  return String(index);
 }
 for(const item of allRows){
  const row=rowElements.get(item.row);
  if(!row)throw Error('صف '+item.row+' لم يعد موجودًا في ملف سجى.');
  // A confirmed historical group belongs to every invoice in that saved group, even
  // when the old record has no per-invoice page allocation. Place its shared transfer
  // numbers in Saja's transfer slots as GROUP associations (not claimed page ownership).
  const transfers=[...new Map([...item.transfers,...item.unassignedTransfers]
   .map(t=>[t.number,t] as const)).values()];
  const original=new Set([
   ...(item.originalTransfers||[]),
   ...Array.from({length:7},(_,i)=>text(getCell(row,columnName(11+i)+item.row),pkg.shared))
    .flatMap(raw=>raw.match(/\d{4,20}/g)||[]),
  ].filter(Boolean));
  let combinedTransfers=false;
  const missingTransfers:string[]=[];
  for(const transfer of transfers){
   if(!transfer.number||original.has(transfer.number))continue;
   // Multiple verified main/dry transfers stay inside K/L; adjustment
   // overflow is comma-separated in Q. Never silently drop a number.
   const col=transfer.kind==='main'?11:transfer.kind==='dry'?12:
    (Array.from({length:5},(_,i)=>13+i).find(c=>{
      const cell=getCell(row,columnName(c)+item.row);
      return !cell||(!find(cell,'f')&&!text(cell,pkg.shared));
    })??17);
   const cell=ensureCell(d,row,col,item.row);
   if(find(cell,'f'))throw Error('فاتورة '+item.number+': خلية ترحيل فيها معادلة.');
   const previous=text(cell,pkg.shared);
   if(previous&&!/^\s*\d{4,20}(?:\s*[,،]\s*\d{4,20})*\s*$/.test(previous))
    throw Error('فاتورة '+item.number+': بيانات غير رقمية في خانة '+columnName(col)+'.');
   const template=getCell(row,'Q'+item.row)||getCell(row,'K'+item.row)||getCell(row,'D'+item.row);
   if(!cell.getAttribute('s')&&template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   if(previous){overwriteText(d,cell,previous+'، '+transfer.number);combinedTransfers=true;}
   else editCell(d,cell,transfer.number,pkg.shared);
   original.add(transfer.number);
  }
  const discrepancy=serialReviewNote(item);
  const transferWarning=missingTransfers.length?
    'ترحيلات عمر لم تتسع لها خانات سجى: '+missingTransfers.join('، '):'';
  const removed=removedNotes.get(item.row)||[];
  const cleanupNote=removed.length?'دُمج الصف '+removed.join('، ')+' في هذا الصف بموافقة المستخدم؛ رقم الفاتورة يظهر مرة واحدة':'';
  const note=[discrepancy,transferWarning,cleanupNote].filter(Boolean).join(' | ');
  const effectiveState=item.origin==='project'?'project_only':transferWarning?'review':item.state;
  if(combinedTransfers&&Number(row.getAttribute('ht')||'0')<44){row.setAttribute('ht','44');row.setAttribute('customHeight','1');}
  if(note){
   const cell=ensureCell(d,row,notes.column,item.row);
   if(!cell.getAttribute('s')){
    const template=getCell(row,'J'+item.row)||getCell(row,'D'+item.row);
    if(template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   }
   const originalNote=value(cell,pkg.shared).trim();
   const combined=originalNote?(originalNote.includes(note)?originalNote:originalNote+' | '+note):note;
   overwriteText(d,cell,combined);
   // Expand only the exceptional row to make the remark readable at a glance.
   const height=Number(row.getAttribute('ht')||'0');
   if(height<33){row.setAttribute('ht','33');row.setAttribute('customHeight','1');}
  }
  for(let col=2;col<=last;col++){
   const cell=ensureCell(d,row,col,item.row);
   if(!cell.getAttribute('s')){
    const template=getCell(row,'D'+item.row);
    if(template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   }
   const colored=styles.apply(cell.getAttribute('s'),effectiveState);
   const multiTransfer=col>=11&&col<=17&&text(cell,pkg.shared).includes('،');
   cell.setAttribute('s',(col===notes.column&&note||multiTransfer)?wrapped(colored):colored);
  }
 }
 if(report.projectOnly?.length){
  const end=Math.max(...allRows.map(row=>row.row));
  const dimension=find(d,'dimension');
  if(dimension){
   const old=dimension.getAttribute('ref')||'A1:Q1';
   const match=old.match(/^([A-Z]+\d+):([A-Z]+)(\d+)$/);
   dimension.setAttribute('ref',(match?.[1]||'A1')+':'+columnName(Math.max(last,cellColumn(match?.[2]||'Q')))+Math.max(end,Number(match?.[3]||1)));
  }
  const autoFilter=find(d,'autoFilter');
  if(autoFilter)autoFilter.setAttribute('ref',(autoFilter.getAttribute('ref')||'').replace(/(:[A-Z]+)(\d+)$/,(_,col,row)=>col+Math.max(Number(row),end)));
  const book=readXml(pkg.files['xl/workbook.xml']);
  for(const name of book.getElementsByTagNameNS(NS,'definedName'))if(name.getAttribute('name')==='_xlnm.Print_Area'){
   const area=(name.textContent||'').replace(/((?:'للطباعة'|للطباعة)!\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?)(\d+)/g,
    (_,prefix,row)=>prefix+Math.max(Number(row),end));
   setText(book,name,area);
  }
  let calc=find(book,'calcPr');
  if(!calc){calc=element(book,'calcPr');book.documentElement.appendChild(calc);}
  calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');
  pkg.files['xl/workbook.xml']=strToU8(new XMLSerializer().serializeToString(book));
 }
 pkg.files[pkg.name]=strToU8(new XMLSerializer().serializeToString(d));
 pkg.files['xl/styles.xml']=strToU8(new XMLSerializer().serializeToString(styles.doc));
 splitIntoDailySheets(pkg,allRows,report.period,last);
 const output=zipSync(pkg.files,{level:6});
 return new Blob([new Uint8Array(output)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
