/** Separate validated unified SAP data into document-complete, immutable source
 * chunks. Transfer chunks use content-defined document boundaries: appending or
 * correcting a transfer leaves unrelated earlier chunks byte-identical.
 *
 * Non-transfer evidence follows the legacy sequential splitting path.
 */
export type UnifiedChunkKind='transfers'|'official'|'journal';
export const SAP_CHUNK_MAX_BYTES=280_000;
const TRANSFER_ANCHOR_MASK=63; // ~one document boundary candidate in 64.
const TRANSFER_MIN_BYTES_FACTOR=0.40;

function stableDocumentHash(key:string):number{
 // FNV-1a over SAP document numbers; same value in Node and browsers.
 let result=2166136261;
 for(let i=0;i<key.length;i++)result=Math.imul(result^key.charCodeAt(i),16777619);
 return result>>>0;
}

/** Content-defined document boundaries.
 * - Stable document order means SAP export order is irrelevant.
 * - A new/changed document generally affects only the nearest chunk.
 * - A natural hash anchor re-synchronizes chunks after inserted documents.
 * - A hard byte limit prevents oversized Worker requests.
 */
function splitTransfersContentDefined(
 header:string,documents:Map<string,{lines:string[];bytes:number}>,
 maxBytes:number,
):string[]{
 const encoder=new TextEncoder();
 const headerBytes=encoder.encode(header).length+1;
 const minimum=Math.max(headerBytes,Math.floor(maxBytes*TRANSFER_MIN_BYTES_FACTOR));
 const items=[...documents.entries()].sort((a,b)=>a[0].localeCompare(b[0],'en'));
 const output:string[]=[];
 let chunk:string[]=[],bytes=headerBytes;
 const flush=()=>{
  if(!chunk.length)return;
  output.push(header+'\n'+chunk.join('\n'));
  chunk=[];bytes=headerBytes;
 };
 for(const [key,document] of items){
  if(document.bytes+headerBytes>maxBytes)
   throw Error('مستند SAP '+key+' أكبر من حجم الجزء الآمن. الأصل محفوظ؛ يلزم معالجة هذا المستند منفصلًا.');
  const atAnchor=(stableDocumentHash(key)&TRANSFER_ANCHOR_MASK)===0;
  if(chunk.length&&(bytes+document.bytes>maxBytes||
      bytes>=minimum&&atAnchor))flush();
  chunk.push(...document.lines);
  bytes+=document.bytes;
 }
 flush();
 return output;
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
 if(kind==='transfers')return splitTransfersContentDefined(header,groups,maxBytes);
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
