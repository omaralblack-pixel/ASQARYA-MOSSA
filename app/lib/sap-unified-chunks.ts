/** Split already-validated unified SAP sections into immutable, independently
 * verifiable source files. Never divide the lines of one SAP document across
 * files; the existing server-side importer owns duplicate and approval checks.
 */
export type UnifiedChunkKind='transfers'|'official'|'journal';
export const SAP_CHUNK_MAX_BYTES=280_000;
export function splitSapSectionIntoChunks(
 text:string,kind:UnifiedChunkKind,maxBytes=SAP_CHUNK_MAX_BYTES
):string[]{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1000)throw Error('حد حجم دفعة SAP غير صالح.');
 const lines=text.replace(/\r/g,'').split('\n').filter(line=>line.trim());
 if(lines.length<2)return [];
 const header=lines[0],head=header.split('\t');
 const docIndex=head.indexOf('Document Number');
 const typeIndex=head.indexOf('نوع المستند'),entryIndex=head.indexOf('DocEntry');
 if(kind==='transfers'&&docIndex<0||kind==='official'&&(typeIndex<0||entryIndex<0))
  throw Error('أعمدة مستندات SAP غير مكتملة؛ لم يتم تقسيم الكشف.');
 const encoder=new TextEncoder(),size=(str:string)=>encoder.encode(str).length;
 const groups=new Map<string,{lines:string[];bytes:number}>();
 for(let i=1;i<lines.length;i++){
  const cols=lines[i].split('\t');
  if(cols.length!==head.length)throw Error('السطر '+(i+1)+': أعمدة SAP غير متطابقة.');
  const key=kind==='transfers'?(cols[docIndex]||'bad-'+i):
   kind==='official'?(cols[typeIndex]&&cols[entryIndex]?
      cols[typeIndex]+'|'+cols[entryIndex]:'bad-'+i):
   'journal-'+i;
  const rowBytes=size(lines[i])+1;
  let group=groups.get(key);
  if(!group){group={lines:[],bytes:0};groups.set(key,group);}
  group.lines.push(lines[i]);group.bytes+=rowBytes;
 }
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
