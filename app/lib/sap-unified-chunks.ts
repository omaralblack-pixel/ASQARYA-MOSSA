/** Separate validated unified SAP data into document-complete, immutable source
 * chunks. Transfer chunks use stable hash buckets: appending one SAP transfer
 * changes only its bucket, not every later byte-position chunk.
 *
 * Non-transfer evidence follows the legacy sequential splitting path.
 */
export type UnifiedChunkKind='transfers'|'official'|'journal';
export const SAP_CHUNK_MAX_BYTES=280_000;
const TRANSFER_BUCKET_BITS=4; // 16 stable base buckets; oversized buckets split locally.

type SapDocument={key:string;lines:string[];bytes:number;hash:number};

function stableDocumentHash(key:string):number{
 // FNV-1a on ASCII document numbers; deterministic across browsers/Node.
 let result=2166136261;
 for(let i=0;i<key.length;i++){
  result=Math.imul(result^key.charCodeAt(i),16777619);
 }
 return result>>>0;
}

function splitTransfersStable(
 header:string,documents:Map<string,{lines:string[];bytes:number}>,
 maxBytes:number,
):string[]{
 const encoder=new TextEncoder();
 const size=(value:string)=>encoder.encode(value).length;
 const overhead=size(header)+1;
 const buckets:SapDocument[][]=Array.from({length:1<<TRANSFER_BUCKET_BITS},()=>[]);
 for(const [key,group] of documents){
  if(group.bytes+overhead>maxBytes)
   throw Error('مستند SAP '+key+' أكبر من حجم الجزء الآمن. الأصل محفوظ؛ يلزم معالجة هذا المستند منفصلًا.');
  const hash=stableDocumentHash(key);
  buckets[hash&((1<<TRANSFER_BUCKET_BITS)-1)].push({key,hash,...group});
 }
 const chunks:string[]=[];
 const emit=(docs:SapDocument[])=>{
  const lines=docs.sort((a,b)=>a.key.localeCompare(b.key,'en'))
   .flatMap(doc=>doc.lines);
  chunks.push(header+'\n'+lines.join('\n'));
 };
 const subdivide=(docs:SapDocument[],depth:number)=>{
  if(!docs.length)return;
  const total=overhead+docs.reduce((sum,doc)=>sum+doc.bytes,0);
  if(total<=maxBytes){emit(docs);return;}
  if(depth>=32)throw Error('تعذّر تقسيم مجموعة ترحيلات SAP دون فصل مستنداتها.');
  const left:SapDocument[]=[],right:SapDocument[]=[];
  for(const doc of docs)((doc.hash>>>depth)&1?right:left).push(doc);
  subdivide(left,depth+1);
  subdivide(right,depth+1);
 };
 for(const bucket of buckets)subdivide(bucket,TRANSFER_BUCKET_BITS);
 return chunks;
}

export function splitSapSectionIntoChunks(
 text:string,kind:UnifiedChunkKind,maxBytes=SAP_CHUNK_MAX_BYTES
):string[]{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1000)
  throw Error('حد حجم دفعة SAP غير صالح.');
 const lines=text.replace(/\r/g,'').split('\n').filter(line=>line.trim());
 if(lines.length<2)return [];
 const header=lines[0],head=header.split('\t');
 const docIndex=head.indexOf('Document Number');
 const typeIndex=head.indexOf('نوع المستند'),entryIndex=head.indexOf('DocEntry');
 if(kind==='transfers'&&docIndex<0||
    kind==='official'&&(typeIndex<0||entryIndex<0))
  throw Error('أعمدة مستندات SAP غير مكتملة؛ لم يتم تقسيم الكشف.');
 const encoder=new TextEncoder(),size=(str:string)=>encoder.encode(str).length;
 const groups=new Map<string,{lines:string[];bytes:number}>();
 for(let i=1;i<lines.length;i++){
  const cols=lines[i].split('\t');
  if(cols.length!==head.length)
   throw Error('السطر '+(i+1)+': أعمدة SAP غير متطابقة.');
  const key=kind==='transfers'?(cols[docIndex]||''):
   kind==='official'?(cols[typeIndex]&&cols[entryIndex]?
      cols[typeIndex]+'|'+cols[entryIndex]:'bad-'+i):
   'journal-'+i;
  // Missing/invalid keys must fail closed instead of silently spreading
  // document lines across unrelated chunks.
  if(kind==='transfers'&&!/^\d{4,20}$/.test(key))
   throw Error('السطر '+(i+1)+': رقم ترحيل SAP مفقود أو غير صالح.');
  const rowBytes=size(lines[i])+1;
  let group=groups.get(key);
  if(!group){group={lines:[],bytes:0};groups.set(key,group);}
  group.lines.push(lines[i]);group.bytes+=rowBytes;
 }
 if(kind==='transfers')return splitTransfersStable(header,groups,maxBytes);
 const headerBytes=size(header)+1,parts:string[]=[];
 let chunk:string[]=[],chunkBytes=headerBytes;
 for(const [key,group] of groups){
  if(group.bytes+headerBytes>maxBytes)
   throw Error('مستند SAP '+key+' أكبر من حجم الجزء الآمن. الأصل محفوظ؛ يلزم معالجة هذا المستند منفصلًا.');
  if(chunk.length&&chunkBytes+group.bytes>maxBytes){
   parts.push(header+'\n'+chunk.join('\n'));chunk=[];chunkBytes=headerBytes;
  }
  chunk.push(...group.lines);chunkBytes+=group.bytes;
 }
 if(chunk.length)parts.push(header+'\n'+chunk.join('\n'));
 return parts;
}
