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
  if(!invoice){
   if(amount&&/^\d+$/.test(serial))errors.push('صف '+index+': يوجد مبلغ ورقم تسلسل بدون رقم فاتورة.');
   continue;
  }
  const number=digits(invoice).replace(/\s/g,'');
  if(!/^\d{8,20}$/.test(number)){
   errors.push('صف '+index+': رقم فاتورة غير صالح ('+invoice+').');
   continue;
  }
  if(!amount)errors.push('صف '+index+': مبلغ الفاتورة '+number+' مفقود.');
  result.push({row:index,number,amount,date:dateValue(text(getCell(row,'C'+index),p.shared))});
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
  pattern.append(fg,bg);fill.appendChild(pattern);fills.appendChild(fill);
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
export function createSerialWorkbook(input:ArrayBuffer,report:SerialReport):Blob {
 if(report.blockers.length)throw Error('لا يمكن تصدير تقرير يحوي أخطاء حرجة.');
 const pkg=load(new Uint8Array(input));
 const actual=rowsFrom(pkg);
 if(actual.errors.length)throw Error(actual.errors.join(' | '));
 if(actual.rows.length!==report.rows.length||actual.rows.some((r,i)=>r.row!==report.rows[i].row||r.number!==report.rows[i].number||r.amount!==report.rows[i].amount))
  throw Error('تغيّر محتوى الملف منذ المطابقة. ارفع ملف سجى من جديد.');
 const styles=ensureStyles(pkg.files);
 const d=pkg.doc,data=find(d,'sheetData')!;
 const rowElements=new Map(children(data,'row').map(row=>[Number(row.getAttribute('r')),row]));
 const count=Math.max(7,...report.rows.map(row=>serialColumns(row.transfers).length));
 const last=10+count;
 if(count>7){
  const headers=[{row:3,base:'Q3'}, {row:4,base:'Q4'}];
  for(const h of headers){
   const row=rowElements.get(h.row)!;
   const origin=getCell(row,h.base);
   for(let c=18;c<=last;c++){
    const cell=ensureCell(d,row,c,h.row);
    if(origin?.getAttribute('s'))cell.setAttribute('s',origin.getAttribute('s')!);
    editCell(d,cell,h.row===3?'تعديل '+(c-12):'تحويل رقم',pkg.shared);
   }
  }
  const cols=find(d,'cols');
  if(cols){
   for(let c=18;c<=last;c++){
    const node=element(d,'col');
    node.setAttribute('min',String(c));node.setAttribute('max',String(c));
    node.setAttribute('width','17');node.setAttribute('customWidth','1');cols.appendChild(node);
   }
  }
  const dim=find(d,'dimension');
  if(dim){const ref=dim.getAttribute('ref')||'A1:Q1';dim.setAttribute('ref',ref.replace(/:[A-Z]+(\d+)$/,':'+columnName(last)+'$1'));}
  // Expand an existing print area if one was set to the original final column.
  const book=readXml(pkg.files['xl/workbook.xml']);
  for(const defined of book.getElementsByTagNameNS(NS,'definedName')){
   if(defined.getAttribute('name')==='_xlnm.Print_Area'&&defined.textContent){
    defined.textContent=defined.textContent.replace(/\$Q(\$\d+)?/g,'$'+columnName(last)+'$1');
   }
  }
  pkg.files['xl/workbook.xml']=strToU8(new XMLSerializer().serializeToString(book));
 }
 for(const item of report.rows){
  const row=rowElements.get(item.row);
  if(!row)throw Error('صف '+item.row+' لم يعد موجودًا في Excel.');
  const transfers=serialColumns(item.transfers);
  for(let c=11;c<=last;c++){
   const cell=ensureCell(d,row,c,item.row);
   if(!cell.getAttribute('s')){
    const template=getCell(row,'Q'+item.row)||getCell(row,'K'+item.row)||getCell(row,'D'+item.row);
    if(template?.getAttribute('s'))cell.setAttribute('s',template.getAttribute('s')!);
   }
   editCell(d,cell,transfers[c-11]||'',pkg.shared);
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
 const output=zipSync(pkg.files,{level:6});
 return new Blob([new Uint8Array(output)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
