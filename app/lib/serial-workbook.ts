import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {digits} from './reconcile';
import {serialColumns, type SerialInput, type SerialReport, type SerialState} from './serial-soldier';

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
 return raw;
}
function rowsFrom(p:Package):{rows:SerialInput[]; errors:string[]}{
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
  result.push({row:index,number,amount,date:dateValue(text(getCell(row,'C'+index),p.shared)),originalTransfers});
 }
 if(!result.length)errors.push('لم أعثر على أي فواتير صالحة في الشيت.');
 return {rows:result,errors};
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
 const palette:Record<SerialState,string>={received:'FFD8F3DC',pending:'FFFAD5E5',missing:'FFFAD5E5',review:'FFFFF0BF'};
 const fillsByState=new Map<SerialState,number>();
 for(const [state,color] of Object.entries(palette) as [SerialState,string][]){
  if(state==='missing'){fillsByState.set(state,fillsByState.get('pending')!);continue;}
  const index=children(fills,'fill').length;
  const fill=element(doc,'fill'),pattern=element(doc,'patternFill'),fg=element(doc,'fgColor'),bg=element(doc,'bgColor');
  pattern.setAttribute('patternType','solid');fg.setAttribute('rgb',color);bg.setAttribute('indexed','64');
  pattern.appendChild(fg);pattern.appendChild(bg);fill.appendChild(pattern);fills.appendChild(fill);
  fillsByState.set(state,index);
 }
 fills.setAttribute('count',String(children(fills,'fill').length));
 const cache=new Map<string,string>();
 return {doc,apply:(style:string|null,state:SerialState)=>{
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
// A separate, non-authoritative audit sheet retains every warning for manual review.
function appendAuditSheet(pkg:Package,report:SerialReport){
 const workbook=readXml(pkg.files['xl/workbook.xml']);
 const sheets=find(workbook,'sheets');
 if(!sheets)throw Error('قائمة شيتات Excel الأصلية مفقودة.');
 const relationships=readXml(pkg.files['xl/_rels/workbook.xml.rels']);
 const contentTypes=readXml(pkg.files['[Content_Types].xml']);
 const sheetIds=Array.from(workbook.getElementsByTagNameNS(NS,'sheet')).map(el=>Number(el.getAttribute('sheetId'))||0);
 const sheetId=Math.max(0,...sheetIds)+1;
 const usedIds=new Set(Array.from(relationships.documentElement.children).map(el=>el.getAttribute('Id')));
 let relNumber=1;while(usedIds.has('rId'+relNumber))relNumber++;
 const relId='rId'+relNumber;
 let path='xl/worksheets/omar-audit.xml',suffix=2;
 while(pkg.files[path])path='xl/worksheets/omar-audit-'+suffix+++'.xml';
 const doc=new DOMParser().parseFromString('<worksheet xmlns="'+NS+'"><sheetData/></worksheet>','application/xml');
 const data=find(doc,'sheetData')!;
 let index=0;
 function put(values:string[]){
  index++;
  const row=element(doc,'row');
  row.setAttribute('r',String(index));
  data.appendChild(row);
  values.forEach((value,c)=>{
   if(!value)return;
   const cell=ensureCell(doc,row,c+1,index);
   editCell(doc,cell,String(value),[]);
  });
 }
 put(['تقرير مراجعة عمر — نسخة للمراجعة فقط، لا تغيّر قاعدة المشروع']);
 put(['عدد فواتير سجى',String(report.rows.length),'واصل',String(report.count.received),'غير واصل',String(report.count.missing),'غير مؤكد',String(report.count.pending),'مراجعة',String(report.count.review)]);
 put(['صف سجى','حالة المطابقة','رقم الفاتورة — عمر','المبلغ — عمر','رقم الفاتورة — سجى','المبلغ — سجى','ترحيلات عمر المرتبطة','ترحيلات المجموعة المعتمدة','الملاحظات']);
 for(const row of report.rows)put([
  String(row.row),({received:'واصل ومطابق',pending:'ورق غير مؤكد',missing:'غير واصل',review:'تحتاج مراجعة'} as Record<SerialState,string>)[row.state],row.omarNumber,row.omarAmount,row.number,row.amount,
  serialColumns(row.transfers).filter(Boolean).join('، '),
  [...new Set((row.unassignedTransfers||[]).map(t=>t.number))].join('، '),row.reason,
 ]);
 index++; // blank line separating invoice data from critical validation findings
 put(['جميع أخطاء الفحص — لا تعني إيقاف تنزيل نسخة المراجعة']);
 for(const issue of report.blockers)put([issue]);
 if(report.legacyWarnings.length){
  index++;
  put(['تنبيهات المجموعات القديمة']);
  for(const warning of report.legacyWarnings)put([warning]);
 }
 const sheet=element(workbook,'sheet');
 const usedNames=new Set(Array.from(workbook.getElementsByTagNameNS(NS,'sheet')).map(el=>el.getAttribute('name')));
 let title='مراجعة عمر',n=2;
 while(usedNames.has(title))title='مراجعة عمر '+n++;
 sheet.setAttribute('name',title);sheet.setAttribute('sheetId',String(sheetId));
 sheet.setAttributeNS(REL,'r:id',relId);sheets.appendChild(sheet);
 const relNS='http://schemas.openxmlformats.org/package/2006/relationships';
 const rel=relationships.createElementNS(relNS,'Relationship');
 rel.setAttribute('Id',relId);
 rel.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');
 rel.setAttribute('Target',path.slice(3));
 relationships.documentElement.appendChild(rel);
 const ctNS='http://schemas.openxmlformats.org/package/2006/content-types';
 const override=contentTypes.createElementNS(ctNS,'Override');
 override.setAttribute('PartName','/'+path);
 override.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
 contentTypes.documentElement.appendChild(override);
 pkg.files['xl/workbook.xml']=strToU8(new XMLSerializer().serializeToString(workbook));
 pkg.files['xl/_rels/workbook.xml.rels']=strToU8(new XMLSerializer().serializeToString(relationships));
 pkg.files['[Content_Types].xml']=strToU8(new XMLSerializer().serializeToString(contentTypes));
 pkg.files[path]=strToU8(new XMLSerializer().serializeToString(doc));
}
export function createSerialWorkbook(input:ArrayBuffer,report:SerialReport):Blob {
 const pkg=load(new Uint8Array(input));
 const actual=rowsFrom(pkg);
 if(actual.rows.length!==report.rows.length||actual.rows.some((r,i)=>r.row!==report.rows[i].row||r.number!==report.rows[i].number||r.amount!==report.rows[i].amount))
  throw Error('تغيّر محتوى الملف منذ المطابقة. ارفع ملف سجى من جديد.');
 const styles=ensureStyles(pkg.files);
 const d=pkg.doc,data=find(d,'sheetData')!;
 const rowElements=new Map(children(data,'row').map(row=>[Number(row.getAttribute('r')),row]));
 // Keep the original D/F and existing transfer values. Append Omar's values in new columns
 // beyond all populated template cells, so Saja's guessed values are always visible.
 let originalEnd=17;
 for(const row of rowElements.values()){
  const no=Number(row.getAttribute('r'));
  if(no!==3&&no!==4&&!report.rows.some(r=>r.row===no))continue;
  for(const cell of children(row,'c')){
   if(value(cell,pkg.shared).trim()||find(cell,'f'))
    originalEnd=Math.max(originalEnd,cellColumn(cell.getAttribute('r')||''));
  }
 }
 const labels=[
  ['بيانات عمر','رقم الفاتورة — عمر'],
  ['بيانات عمر','المبلغ — عمر'],
  ['بيانات سجى الأصلية','رقم الفاتورة — سجى'],
  ['بيانات سجى الأصلية','المبلغ — سجى'],
  ['ترحيلات عمر','ترحيلات مرتبطة بالفاتورة'],
  ['ترحيلات المجموعة المعتمدة','غير منسوبة لصفحة منفردة'],
  ['نتيجة المراجعة','الملاحظات والفروقات'],
 ];
 const start=originalEnd+1,last=start+labels.length-1;
 for(const rowNo of [3,4]){
  const row=rowElements.get(rowNo);
  if(!row)throw Error('صف عنوان سجى '+rowNo+' مفقود.');
  const template=getCell(row,'Q'+rowNo)||getCell(row,'K'+rowNo);
  for(let i=0;i<labels.length;i++){
   const cell=ensureCell(d,row,start+i,rowNo);
   if(template?.getAttribute('s')&&!cell.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   editCell(d,cell,labels[i][rowNo===3?0:1],pkg.shared);
  }
 }
 const cols=find(d,'cols');
 if(cols){
  for(let c=start;c<=last;c++){
   const node=element(d,'col');
   node.setAttribute('min',String(c));node.setAttribute('max',String(c));
   node.setAttribute('width',c===last?'60':'23');node.setAttribute('customWidth','1');cols.appendChild(node);
  }
 }
 const dim=find(d,'dimension');
 if(dim){
  const ref=dim.getAttribute('ref')||'A1:Q1';
  dim.setAttribute('ref',ref.replace(/:[A-Z]+(\d+)$/,':'+columnName(last)+'$1'));
 }
 const book=readXml(pkg.files['xl/workbook.xml']);
 const originalName=columnName(originalEnd);
 for(const defined of book.getElementsByTagNameNS(NS,'definedName')){
  if(defined.getAttribute('name')==='_xlnm.Print_Area'&&defined.textContent){
   const expr=new RegExp('\\$'+originalName+'(?=\\$\\d+)','g');
   defined.textContent=defined.textContent.replace(expr,'$'+columnName(last));
  }
 }
 pkg.files['xl/workbook.xml']=strToU8(new XMLSerializer().serializeToString(book));
 for(const item of report.rows){
  const row=rowElements.get(item.row);
  if(!row)throw Error('صف '+item.row+' لم يعد موجودًا في Excel.');
  const transfers=serialColumns(item.transfers);
  const conflicts:string[]=[];
  // Only fill blank K:Q positions. A differing original value remains untouched;
  // the full authoritative transfer list is always written into Omar's own column.
  for(let c=11;c<=17;c++){
   const expected=transfers[c-11]||'';
   if(!expected)continue;
   const cell=ensureCell(d,row,c,item.row);
   const existing=value(cell,pkg.shared).trim();
   if(find(cell,'f')||(existing&&existing!==expected)){
    conflicts.push(columnName(c)+': سجى '+(existing||'معادلة')+' / عمر '+expected);
    continue;
   }
   if(existing===expected)continue; // preserve original Excel cell type and value
   if(!cell.getAttribute('s')){
    const template=getCell(row,'Q'+item.row)||getCell(row,'K'+item.row)||getCell(row,'D'+item.row);
    if(template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   }
   editCell(d,cell,expected,pkg.shared);
  }
  const transferNumbers=[...item.transfers,...item.unassignedTransfers,...(item.originalTransfers||[]).map(number=>({number,kind:'adjustment' as const}))].map(t=>t.number);
  const related=report.blockers.filter(issue=>
    issue.startsWith('صف '+item.row+':')||
    [item.number,item.omarNumber].filter(Boolean).some(no=>issue.includes('فاتورة '+no))||
    transferNumbers.some(no=>issue.includes('الترحيل '+no)));
  const notes=[item.reason,...related,...conflicts.map(v=>'اختلاف الترحيل '+v)].filter(Boolean).filter((n,i,a)=>a.indexOf(n)===i).join(' | ');
  const values=[
    item.omarNumber,item.omarAmount,item.number,item.amount,
    transfers.filter(Boolean).join('، '),
    [...new Set(item.unassignedTransfers.map(t=>t.number))].join('، '),
    notes
  ];
  for(let i=0;i<values.length;i++){
   const cell=ensureCell(d,row,start+i,item.row);
   const template=getCell(row,'Q'+item.row)||getCell(row,'D'+item.row);
   if(!cell.getAttribute('s')&&template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   editCell(d,cell,values[i],pkg.shared);
  }
  for(let c=2;c<=last;c++){
   const cell=ensureCell(d,row,c,item.row);
   if(!cell.getAttribute('s')){
    const template=getCell(row,'D'+item.row);
    if(template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   }
   cell.setAttribute('s',styles.apply(cell.getAttribute('s'),item.state));
  }
 }
 pkg.files[pkg.name]=strToU8(new XMLSerializer().serializeToString(d));
 pkg.files['xl/styles.xml']=strToU8(new XMLSerializer().serializeToString(styles.doc));
 appendAuditSheet(pkg,report);
 const output=zipSync(pkg.files,{level:6});
 return new Blob([new Uint8Array(output)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
