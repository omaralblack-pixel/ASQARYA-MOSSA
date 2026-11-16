import {strFromU8,unzipSync} from 'fflate';
import {decodeLieutenantFile} from './lieutenant-file';

/** XML text produced by Excel may use shared strings, inline strings and XML entities. */
const decodeEntities=(value:string)=>value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity:string)=>{
  if(entity[0]==='#'){
    const n=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
    return Number.isInteger(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'\uFFFD';
  }
  return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity.toLowerCase()]||'';
});
const attr=(source:string,name:string)=>{
  const escaped=name.replace(/[.*+?^\x24{}()|[\]\\]/g,'\\\x24&');
  const match=new RegExp('(?:^|\\s)'+escaped+'\\s*=\\s*(?:"([^"]*)"|\\\x27([^\\\x27]*)\\\x27)','i').exec(source);
  return decodeEntities(match?.[1]??match?.[2]??'');
};
const nodes=(source:string,name:string)=>{
  const tag='(?:[\\w-]+:)?'+name;
  return [...source.matchAll(new RegExp('<'+tag+'\\b[^>]*>([\\s\\S]*?)<\\/'+tag+'\\s*>','gi'))].map(m=>m[1]);
};
const starts=(source:string,name:string)=>{
  const tag='(?:[\\w-]+:)?'+name;
  return [...source.matchAll(new RegExp('<'+tag+'\\b([^>]*?)(?:\\/?>)','gi'))].map(m=>m[1]);
};
const textNodes=(source:string)=>nodes(source,'t').map(decodeEntities).join('');
const columnIndex=(value:string)=>{
  const letters=value.match(/^[A-Z]+/i)?.[0]?.toUpperCase()||'';
  let number=0;for(const letter of letters)number=number*26+letter.charCodeAt(0)-64;
  return number-1;
};
/** Server-side independent XLSX readback. A mismatched extraction must not be processed. */
export function archivedXlsxToTsv(bytes:Uint8Array):string{
  if(bytes.byteLength>16*1024*1024)throw Error('ملف Excel يتجاوز حد الأرشيف.');
  const zip=unzipSync(bytes);
  const xml=(path:string)=>{
    const value=zip[path];if(!value||value.length>60*1024*1024)throw Error('ملف Excel غير مكتمل أو كبير جدًا: '+path);
    return strFromU8(value);
  };
  const shared=zip['xl/sharedStrings.xml']?nodes(xml('xl/sharedStrings.xml'),'si').map(textNodes):[];
  const workbook=xml('xl/workbook.xml'),rels=xml('xl/_rels/workbook.xml.rels');
  const relations=new Map(starts(rels,'Relationship').map(a=>[attr(a,'Id'),attr(a,'Target')]));
  const worksheets:string[]=[];
  for(const sheet of starts(workbook,'sheet')){
    const id=attr(sheet,'r:id')||attr(sheet,'id');
    const target=relations.get(id);
    if(!target)continue;
    const path='xl/'+target.replace(/^\/+/, '').replace(/^xl\//,'');
    if(!zip[path])continue;
    const rows=nodes(xml(path),'row').map(row=>{
      const cells:string[]=[];let last=-1;
      for(const cellMatch of row.matchAll(/<(?:[\w-]+:)?c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:[\w-]+:)?c\s*>)/gi)){
        const a=cellMatch[1],body=cellMatch[2]||'';
        let index=columnIndex(attr(a,'r'));if(index<0)index=last+1;
        if(index>300)throw Error('ورقة Excel تحتوي أعمدة كثيرة وغير متوقعة.');
        last=index;
        const v=nodes(body,'v')[0]||'';
        const t=attr(a,'t');
        const value=t==='s'?shared[Number(v)]||'':t==='inlineStr'?textNodes(body):decodeEntities(v);
        cells[index]=value.replace(/[\t\r\n]+/g,' ').trim();
      }
      return Array.from({length:cells.length},(_,i)=>cells[i]||'').join('\t');
    }).filter(Boolean);
    if(rows.length)worksheets.push(rows.join('\n'));
  }
  if(!worksheets.length)throw Error('ملف Excel لا يحتوي على أوراق قابلة للتحقق.');
  const combined=worksheets.join('\n');
  if(combined.length>25*1024*1024)throw Error('نص Excel المستخرج كبير جدًا.');
  return combined;
}
export function decodeArchivedSapSource(bytes:Uint8Array,filename:string):string{
  if(filename.toLowerCase().endsWith('.xlsx'))return archivedXlsxToTsv(bytes);
  const exact=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  return decodeLieutenantFile(exact,filename);
}
