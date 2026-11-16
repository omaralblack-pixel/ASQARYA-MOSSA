import {strToU8,zipSync} from 'fflate';
import {fils,invoiceDocumentNo,parseTransfer,readReconciliationRecord,transferNumbers} from './reconcile';
import {invoiceDate} from './invoice-collector';
import type {SerialRecord} from './serial-soldier';

/** One line per distinct saved blue-invoice number, without changing any saved record. */
export type ProjectInvoiceExportRow = {
 number:string;date:string;branch:string;amount:string;status:string;
 main:string;dry:string;adjustments:string;notes:string;recordIds:string;
 amountFils:number|null;
};

type Source = {
 number:string;date:string;branch:string;amount:string;status:string;
 main:string[];dry:string[];adjustments:string[];notes:string[];
 recordId:string;
};
const unique=(items:string[])=>[...new Set(items.filter(Boolean))];
const oneOrMany=(items:string[])=>unique(items).join('، ');

export function projectInvoiceExportRows(records:SerialRecord[]):ProjectInvoiceExportRow[] {
 const groups=new Map<string,Source[]>();
 for(const record of records){
  const draft=readReconciliationRecord(record.payload);
  if(!draft){
   // Show the corrupt record as an exception rather than silently losing it.
   const key='invalid-record:'+record.id;
   groups.set(key,[{number:'سجل غير مقروء',date:'',branch:record.branch||'',amount:'',
    status:'مراجعة بيانات السجل',main:[],dry:[],adjustments:[],
    notes:['تعذر قراءة الفواتير المحفوظة في هذا السجل'],recordId:record.id}]);
   continue;
  }
  const main:string[]=[],dry:string[]=[],adjustments:string[]=[],transferNotes:string[]=[];
  for(const transfer of draft.transfers||[]){
   const parsed=parseTransfer(transfer.paste||'',{allowReverse:true});
   const routes=unique(parsed.lines.map(line=>line.from+'>'+line.to));
   const valid=parsed.lines.length>0&&!parsed.issues.length&&!parsed.excluded.length;
   const kind=valid&&routes.length===1&&routes[0]==='001>011'?'main':
    valid&&routes.length===1&&routes[0]==='002>011'?'dry':'adjustments';
   const numbers=transferNumbers(transfer.number||'');
   if(!valid)transferNotes.push('الترحيل '+(transfer.number||'بدون رقم')+' يحتاج مراجعة بنود SAP');
   if(!numbers.length&&transfer.number)transferNotes.push('رقم ترحيل غير صالح: '+transfer.number);
   const target=kind==='main'?main:kind==='dry'?dry:adjustments;
   target.push(...(numbers.length?numbers:transfer.number?[String(transfer.number)]:[]));
  }
  const savedStatus=(draft as typeof draft & {summary?:{status?:string}}).summary?.status||record.status||'';
  for(const [i,invoice] of draft.invoices.entries()){
   const number=invoiceDocumentNo(invoice.number);
   const original=String(invoice.number||'').trim();
   const key=number||'unnumbered:'+record.id+':'+i;
   const resolved=invoiceDate(invoice,draft.transfers||[]);
   const notes=[...transferNotes];
   if(!number)notes.push('رقم الفاتورة مفقود أو غير صالح'+(original?' ('+original+')':''));
   if(!resolved.date)notes.push(resolved.reason||'تاريخ الفاتورة غير مثبت');
   else if(resolved.source==='transfer')notes.push('تاريخ مستنتج من ترحيل SAP، وليس تاريخًا مؤكدًا من الورق');
   const status=invoice.complete!==true?'الورق غير مؤكد':
    !draft.transfers.length?'لا يوجد ترحيل مرتبط':
    savedStatus&&savedStatus!=='match'?'المطابقة غير معتمدة ('+savedStatus+')':
    transferNotes.length?'ترحيلات تحتاج مراجعة':'معتمدة في سجل المشروع';
   const source:Source={number:number||original||'بدون رقم',date:resolved.date||'',
    branch:record.branch||draft.branch||'',amount:String(invoice.amount||''),
    status,main:unique(main),dry:unique(dry),adjustments:unique(adjustments),
    notes,recordId:record.id};
   groups.set(key,[...(groups.get(key)||[]),source]);
  }
 }
 const rows:ProjectInvoiceExportRow[]=[];
 for(const sources of groups.values()){
  const number=sources[0].number;
  const dates=unique(sources.map(x=>x.date)),branches=unique(sources.map(x=>x.branch));
  const amounts=unique(sources.map(x=>x.amount)),statuses=unique(sources.map(x=>x.status));
  const duplicated=sources.length>1;
  const notes=unique(sources.flatMap(x=>x.notes));
  if(duplicated){
   notes.unshift('رقم الفاتورة مكرر في '+sources.length+' مواضع من سجلات المشروع؛ عُرض مرة واحدة دون حذف النسخ الأصلية');
   if(amounts.length>1)notes.push('مبالغ متعارضة في السجلات: '+amounts.join(' / '));
   if(dates.length>1)notes.push('تواريخ متعارضة في السجلات');
   if(branches.length>1)notes.push('فروع متعارضة في السجلات');
  }
  const amountFils=amounts.length===1?fils(amounts[0]):null;
  rows.push({
   number,date:oneOrMany(dates),branch:oneOrMany(branches),
   amount:amounts.join(' / '),amountFils,
   status:duplicated?'رقم مكرر — يحتاج مراجعة':oneOrMany(statuses),
   main:oneOrMany(sources.flatMap(x=>x.main)),
   dry:oneOrMany(sources.flatMap(x=>x.dry)),
   adjustments:oneOrMany(sources.flatMap(x=>x.adjustments)),
   notes:notes.join(' | '),recordIds:oneOrMany(sources.map(x=>x.recordId)),
  });
 }
 return rows.sort((a,b)=>a.date.localeCompare(b.date)||a.number.localeCompare(b.number,'en',{numeric:true}));
}

const xml=(v:unknown)=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'')
 .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const column=(n:number)=>{let s='';for(let v=n;v;v=Math.floor((v-1)/26))s=String.fromCharCode(65+(v-1)%26)+s;return s;};
const headers=['رقم الفاتورة','تاريخ الفاتورة','الفرع','المبلغ (دينار)','حالة الفاتورة',
 'رئيسي 001→011','نواشف 002→011','تعديلات / عكسي','ملاحظات وتعارضات','معرّفات السجلات'];

function textCell(col:number,row:number,value:string,style:number){
 const address=column(col)+row;
 return '<c r="'+address+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
}
function numberCell(col:number,row:number,value:number,style:number){
 return '<c r="'+column(col)+row+'" s="'+style+'"><v>'+value+'</v></c>';
}

/** Independent Excel download; it needs no Saja template and performs no writes. */
export function createProjectInvoicesWorkbook(records:SerialRecord[]):Blob{
 const lines=projectInvoiceExportRows(records);
 const data=[ '<row r="1" ht="30" customHeight="1">'+headers.map((h,i)=>textCell(i+1,1,h,1)).join('')+'</row>' ];
 for(const [i,line] of lines.entries()){
  const row=i+2,style=line.status.includes('مكرر')||line.status.includes('مراجعة')?3:2;
  const fields=[line.number,line.date,line.branch,line.amount,line.status,line.main,
   line.dry,line.adjustments,line.notes,line.recordIds];
  data.push('<row r="'+row+'" ht="26" customHeight="1">'+fields.map((v,c)=>
   c===3&&line.amountFils!==null?numberCell(c+1,row,line.amountFils/1000,4):textCell(c+1,row,v,style)).join('')+'</row>');
 }
 const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
  '<dimension ref="A1:J'+Math.max(1,lines.length+1)+'"/><sheetViews><sheetView workbookViewId="0" rightToLeft="1">'+
  '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'+
  '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/>'+
  '<cols><col min="1" max="1" width="20" customWidth="1"/><col min="2" max="2" width="16" customWidth="1"/>'+
  '<col min="3" max="3" width="29" customWidth="1"/><col min="4" max="4" width="17" customWidth="1"/>'+
  '<col min="5" max="5" width="28" customWidth="1"/><col min="6" max="8" width="25" customWidth="1"/>'+
  '<col min="9" max="9" width="72" customWidth="1"/><col min="10" max="10" width="39" customWidth="1"/></cols>'+
  '<sheetData>'+data.join('')+'</sheetData><autoFilter ref="A1:J'+Math.max(1,lines.length+1)+'"/>'+
  '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>';
 const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
  '<numFmts count="1"><numFmt numFmtId="165" formatCode="0.000"/></numFmts>'+
  '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font>'+
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>'+
  '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'+
  '<fill><patternFill patternType="solid"><fgColor rgb="FF23415F"/><bgColor indexed="64"/></patternFill></fill>'+
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF0BF"/><bgColor indexed="64"/></patternFill></fill></fills>'+
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
  '<cellXfs count="5">'+
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>'+
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>'+
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>'+
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>'+
  '</cellXfs></styleSheet>';
 const workbook='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '+
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
  '<sheets><sheet name="فواتير المشروع" sheetId="1" r:id="rId1"/></sheets></workbook>';
 const files:Record<string,Uint8Array>={
  '[Content_Types].xml':strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
   '<Default Extension="xml" ContentType="application/xml"/>'+
   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
  '_rels/.rels':strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  'xl/_rels/workbook.xml.rels':strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'+
   '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
  'xl/workbook.xml':strToU8(workbook),
  'xl/worksheets/sheet1.xml':strToU8(sheet),
  'xl/styles.xml':strToU8(styles),
 };
 const output=zipSync(files,{level:6});
 return new Blob([new Uint8Array(output)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
