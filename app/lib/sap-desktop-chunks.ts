/** Deterministic raw unified chunks: WINDOW accompanies every chunk, while a
 * transfer or official document remains whole. Python desktop uses the same
 * byte-level contract; server independently reconstructs it before publication. */
export const desktopChunkBytes=280000;
export function desktopUnifiedChunks(text:string,maxBytes=desktopChunkBytes):string[]{
 const lines=text.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n').filter(x=>x.trim());
 const header=lines.shift()||'',columns=header.split('\t');
 if(!columns.includes('RecordType'))return [];
 const idx=(name:string)=>{const i=columns.indexOf(name);if(i<0)throw Error('Missing unified SAP column: '+name);return i;};
 const kind=idx('RecordType'),number=idx('DocumentNumber'),type=idx('DocumentType'),entry=idx('DocEntry');
 const windows=lines.filter(x=>x.split('\t')[kind]==='WINDOW');
 if(windows.length!==1)throw Error('Unified source must contain one WINDOW row');
 const prefix=header+'\n'+windows[0],size=(x:string)=>new TextEncoder().encode(x).length;
 const groups=new Map<string,string[]>();
 for(const [i,line] of lines.entries()){
  const cells=line.split('\t'),k=cells[kind];
  if(cells.length!==columns.length||!['WINDOW','TRANSFER','OFFICIAL','OPENING','CLOSING','OINM'].includes(k))throw Error('Invalid unified SAP row '+(i+2));
  // Stock is archival evidence, never an import batch. Keep the complete
  // snapshots only in the parent so no child can look like a partial balance.
  if(['WINDOW','OPENING','CLOSING'].includes(k))continue;
  const key=k==='TRANSFER'?k+':'+cells[number]:k==='OFFICIAL'?k+':'+cells[type]+'|'+cells[entry]:k+':'+i;
  const group=groups.get(key)||[];group.push(line);groups.set(key,group);
 }
 const chunks:string[]=[];let chunk=prefix,chunkSize=size(prefix);const prefixSize=chunkSize;
 for(const group of groups.values()){
  const body='\n'+group.join('\n');
  const bodySize=size(body);
  if(prefixSize+bodySize>maxBytes)throw Error('مستند SAP واحد أكبر من حد الجزء الآمن؛ الأصل محفوظ للمراجعة.');
  if(chunkSize+bodySize>maxBytes){chunks.push(chunk);chunk=prefix;chunkSize=prefixSize;}
  chunk+=body;chunkSize+=bodySize;
 }
 if(chunk!==prefix)chunks.push(chunk);
 return chunks;
}
