#!/usr/bin/env node
/**
 * Read-only comparison of two locally available, complete SAP 011 unified TSV
 * exports. No uploads, DB calls, writes or source-file modification.
 * Supports SAP Business One's optional "#" row-number column and UTF-16LE.
 *
 * Run:
 *   node scripts/audit-sap-monthly-sources.mjs old.txt new.txt
 *
 * Fails closed on invalid headers, inconsistent windows, duplicate transfer
 * line identities, malformed records, or suspicious disappeared documents.
 * This is audit evidence, not permission to activate a snapshot.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const FIELDS=['RecordType','DocumentType','DocumentNumber','DocEntry','DocumentDate',
 'LineNumber','ItemCode','Quantity','FromWarehouse','ToWarehouse','CancellationStatus',
 'StockQuantity','TransNum','TransType','BaseRef'];
const REQUIRED=['RecordType','DocumentNumber','DocumentDate','ItemCode','StockQuantity'];
const KINDS=['TRANSFER','OPENING','CLOSING','OINM','OFFICIAL','WINDOW'];
const VALID_DAY=/^\d{4}-\d{2}-\d{2}$/;
const isDay=s=>VALID_DAY.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&
 new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const hash=value=>createHash('sha256').update(value).digest('hex');
function readText(path){
 const b=readFileSync(path);
 if(!b.length||b.length>128*1024*1024)throw Error('ملف SAP فارغ أو يتجاوز حد 128MB: '+path);
 if(b[0]===0xff&&b[1]===0xfe)return b.subarray(2).toString('utf16le');
 if(b[0]===0xfe&&b[1]===0xff)throw Error('تصدير UTF-16BE غير مدعوم دون تحويل موثوق.');
 const t=b.toString('utf8').replace(/^\uFEFF/,'');
 if(t.includes('\ufffd'))throw Error('تعذّر قراءة الترميز بدقة: '+path);
 return t;
}
function snapshot(path){
 const lines=readText(path).replace(/\r/g,'').split('\n').filter(l=>l.trim());
 if(lines.length<2)throw Error('كشف SAP غير مكتمل: '+path);
 const rawHeaders=lines[0].split('\t');
 // SAP client prepends a display-only row index called "#", and sometimes
 // exports an empty trailing column. Neither is part of the SAP evidence.
 const headers=rawHeaders.map(x=>x.trim());
 const indices=headers.map((header,i)=>({header,i}))
  .filter(x=>x.header&&x.header!=='#')
  .sort((a,b)=>a.header.localeCompare(b.header,'en'));
 // Canonical column order prevents false changes when SAP reorders headers.
 const used=indices.map(x=>x.header);
 if(new Set(used).size!==used.length)throw Error('أعمدة مكررة في '+path);
 for(const name of REQUIRED)if(!used.includes(name))throw Error('عمود مطلوب ناقص: '+name);
 const positions=new Map(indices.map(x=>[x.header,x.i]));
 const allowed=new Set(KINDS);
 const collections=Object.fromEntries(KINDS.map(k=>[k,new Map()]));
 const counts=Object.fromEntries(KINDS.map(k=>[k,0]));
 const cancellations={N:0,Y:0,C:0,unknown:0};
 const duplicateKeys=[];
 for(let i=1;i<lines.length;i++){
  const values=lines[i].split('\t');
  if(values.length!==headers.length)
   throw Error('اختلاف عدد الأعمدة في '+path+'، سطر '+(i+1));
  const get=k=>String(values[positions.get(k)]??'').trim();
  const kind=get('RecordType');
  if(!allowed.has(kind))throw Error('نوع سجل غير معروف في سطر '+(i+1)+': '+kind);
  const relevant=indices.map(x=>x.header+':'+JSON.stringify(values[x.i]??'')).join('|');
  counts[kind]++;
  const items=collections[kind];
  let key='';
  if(kind==='TRANSFER'){
   const num=get('DocumentNumber'),line=get('LineNumber');
   if(!/^\d{4,20}$/.test(num)||!line)
    throw Error('مستند ترحيل أو رقم سطر غير صالح عند '+(i+1));
   key=num+'|'+line;
   const state=get('CancellationStatus').toUpperCase();
   if(Object.hasOwn(cancellations,state))cancellations[state]++;
   else cancellations.unknown++;
  }else if(kind==='OFFICIAL'){
   key=[get('DocumentType'),get('DocEntry'),get('LineNumber'),get('ItemCode')].join('|');
   if(!get('DocumentType')||!get('DocEntry')||!get('LineNumber'))
    throw Error('هوية مستند رسمي ناقصة في '+(i+1));
  }else if(kind==='OINM'){
   // Inventory movement rows can have multiple legitimately similar keys.
   // Use a multiset of complete raw content fingerprints, not doc numbers.
   key=hash(relevant);
  }else if(kind==='WINDOW'){
   key='WINDOW';
  }else{
   // Opening/closing are date-scoped balances (not transfer documents).
   key=[get('DocumentDate'),get('ItemCode')].join('|');
   if(!get('ItemCode')||!isDay(get('DocumentDate')))
    throw Error('رصيد SAP بلا تاريخ أو صنف سليم في '+(i+1));
  }
  if(kind==='TRANSFER'||kind==='OFFICIAL'||kind==='WINDOW'||kind==='OPENING'||kind==='CLOSING'){
   if(items.has(key))duplicateKeys.push(kind+':'+key);
   else items.set(key,relevant);
  }else{
   items.set(key,(items.get(key)||0)+1);
  }
 }
 if(duplicateKeys.length)
  throw Error('هويات سجلات SAP مكررة: '+duplicateKeys.slice(0,5).join('، '));
 const w=collections.WINDOW;
 if(w.size!==1)throw Error('كشف SAP بلا نافذة واحدة محددة.');
 const windowValues=lines.find(line=>{
  const cells=line.split('\t');return cells[positions.get('RecordType')]==='WINDOW';
 })?.split('\t')||[];
 const from=String(windowValues[positions.get('DocumentDate')]||'').trim();
 const to=String(windowValues[positions.get('BaseRef')]||'').trim();
 if(!isDay(from)||!isDay(to)||to<from)throw Error('نافذة تاريخ SAP غير صالحة.');
 return {path,from,to,headers:used,counts,collections,cancellations};
}
function compareMaps(before,after){
 const added=[],removed=[],modified=[];
 for(const [k,v] of after)if(!before.has(k))added.push(k);
  else if(before.get(k)!==v)modified.push(k);
 for(const k of before.keys())if(!after.has(k))removed.push(k);
 return {old:before.size,new:after.size,added:added.length,modified:modified.length,
  disappeared:removed.length,sampleChanged:[...added,...modified].slice(0,10),
  sampleDisappeared:removed.slice(0,10)};
}
export function compareSapSources(oldPath,newPath){
 const old=snapshot(oldPath),now=snapshot(newPath);
 const critical=FIELDS.filter(x=>(old.headers.includes(x)!==now.headers.includes(x)));
 const allHeaders=[...new Set([...old.headers,...now.headers])];
 const difference=allHeaders.filter(x=>old.headers.includes(x)!==now.headers.includes(x));
 const warnings=[];
 if(critical.length)warnings.push('مخطط الأعمدة تغيّر: '+critical.join(', '));
 if(difference.length)warnings.push('اختلاف الأعمدة: '+difference.join(', '));
 if(old.from!==now.from)warnings.push('تاريخ بداية الكشفين مختلف.');
 if(now.to<old.to)warnings.push('تاريخ نهاية الكشف الجديد أقدم من السابق.');
 const kinds={};
 for(const kind of KINDS)if(kind!=='WINDOW')
  kinds[kind]=compareMaps(old.collections[kind],now.collections[kind]);
 if(kinds.TRANSFER.disappeared)warnings.push('اختفاء سطور ترحيل من الكشف الجديد: يتطلب تدقيقًا في المصدر.');
 if(kinds.OFFICIAL.disappeared)warnings.push('اختفاء سطور مستندات رسمية: يتطلب تدقيقًا.');
 // Older opening balance date must be stable when the from-date is unchanged.
 if(old.from===now.from&&kinds.OPENING.modified+ kinds.OPENING.disappeared)
  warnings.push('تغيّر الرصيد الافتتاحي لنفس تاريخ البداية: يلزم تدقيق.');
 const safeForManualReview=warnings.length===0;
 return {scope:{before:{from:old.from,to:old.to},after:{from:now.from,to:now.to}},
  sourceLines:{before:old.counts,after:now.counts},
  cancellations:{before:old.cancellations,after:now.cancellations},
  kinds,warnings,safeForManualReview,
  note:'Read-only comparison. A clean report is not proof of SAP completeness or authorization to activate.'};
}
if(process.argv[1]?.endsWith('audit-sap-monthly-sources.mjs')){
 const [a,b]=process.argv.slice(2);
 if(!a||!b){console.error('Usage: node scripts/audit-sap-monthly-sources.mjs old.txt new.txt');process.exitCode=2;}
 else try{
  const result=compareSapSources(a,b);
  console.log(JSON.stringify(result,null,2));
  if(!result.safeForManualReview)process.exitCode=1;
 }catch(e){console.error('SAP audit blocked: '+(e instanceof Error?e.message:String(e)));process.exitCode=1;}
}
