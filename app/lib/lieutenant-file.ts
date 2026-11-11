import {strFromU8,unzipSync} from 'fflate';

function parseCsv(text:string):string{
  const rows:string[][]=[];
  let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'&&quoted&&text[i+1]==='"'){cell+='"';i++;continue}
    if(c==='"'){quoted=!quoted;continue}
    if(!quoted&&(c===','||c==='\n'||c==='\r')){
      row.push(cell);cell='';
      if(c===',')continue;
      if(c==='\r'&&text[i+1]==='\n')i++;
      rows.push(row);row=[];
      continue;
    }
    cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows.map(values=>values.map(value=>value.replace(/[\t\r\n]+/g,' ').trim()).join('\t')).join('\n');
}

const local=(name:string)=>name.split(':').pop()||'';
const tag=(node:Element,name:string)=>Array.from(node.children).find(child=>local(child.tagName)===name);
const elements=(node:Document|Element,name:string)=>
  Array.from(node.getElementsByTagName('*')).filter(element=>local(element.tagName)===name);
const columnIndex=(cell:string)=>{
  const letters=cell.match(/^[A-Z]+/i)?.[0].toUpperCase()||'';
  let number=0;
  for(const c of letters)number=number*26+c.charCodeAt(0)-64;
  return number-1;
};

/** Read worksheets locally, without transmitting Excel content to a third-party parser. */
function xlsxToTsv(bytes:Uint8Array):string{
  if(bytes.byteLength>16*1024*1024)throw Error('ملف Excel كبير جدًا.');
  const zip=unzipSync(bytes);
  const xml=(path:string)=>{
    const value=zip[path];
    if(!value)throw Error('ملف Excel لا يحتوي على '+path);
    if(value.length>60*1024*1024)throw Error('ورقة Excel كبيرة جدًا.');
    const parsed=new DOMParser().parseFromString(strFromU8(value),'application/xml');
    if(parsed.getElementsByTagName('parsererror').length)throw Error('تعذّر تحليل XML في Excel.');
    return parsed;
  };
  const shared=zip['xl/sharedStrings.xml']
    ?elements(xml('xl/sharedStrings.xml'),'si').map(si=>
      elements(si,'t').map(t=>t.textContent||'').join(''))
    :[];
  const workbook=xml('xl/workbook.xml');
  const relations=xml('xl/_rels/workbook.xml.rels');
  const targets=new Map(elements(relations,'Relationship').map(r=>[r.getAttribute('Id')||'',r.getAttribute('Target')||'']));
  const worksheets:string[]=[];
  for(const sheet of elements(workbook,'sheet')){
    const id=sheet.getAttribute('r:id')||sheet.getAttribute('id')||'';
    const target=targets.get(id);
    if(!target)continue;
    const normalized=target.replace(/^\/+/, '').replace(/^xl\//,'');
    const path='xl/'+normalized;
    if(!zip[path])continue;
    const doc=xml(path);
    const rows=elements(doc,'row').map(row=>{
      const cells:string[]=[];
      let last=-1;
      for(const cell of elements(row,'c')){
        let idx=columnIndex(cell.getAttribute('r')||'');
        if(idx<0)idx=last+1;
        if(idx>300)throw Error('ورقة Excel تحتوي على أعمدة كثيرة وغير متوقعة.');
        last=idx;
        let value=tag(cell,'v')?.textContent||'';
        if(cell.getAttribute('t')==='s')value=shared[Number(value)]||'';
        else if(cell.getAttribute('t')==='inlineStr')value=elements(cell,'t').map(t=>t.textContent||'').join('');
        cells[idx]=value.replace(/[\t\r\n]+/g,' ').trim();
      }
      return Array.from({length:cells.length},(_,i)=>cells[i]||'').join('\t');
    }).filter(Boolean);
    if(rows.length)worksheets.push(rows.join('\n'));
  }
  if(!worksheets.length)throw Error('ملف Excel لا يحتوي على أوراق بيانات قابلة للقراءة.');
  const combined=worksheets.join('\n');
  if(combined.length>25*1024*1024)throw Error('البيانات المستخرجة من Excel كبيرة جدًا.');
  return combined;
}

export function decodeLieutenantFile(bytes:ArrayBuffer,name:string):string{
  const extension=name.split('.').pop()?.toLowerCase();
  if(extension==='xlsx')return xlsxToTsv(new Uint8Array(bytes));
  if(!['txt','csv','tsv'].includes(extension||''))throw Error('الملف محفوظ في الأرشيف، لكن التدقيق يتطلب TXT أو CSV أو XLSX.');
  const input=new Uint8Array(bytes);
  const encoding=input[0]===255&&input[1]===254?'utf-16le':
    input[0]===254&&input[1]===255?'utf-16be':'utf-8';
  const text=new TextDecoder(encoding,{fatal:true}).decode(input).replace(/^\uFEFF/,'');
  return extension==='csv'&&!text.split('\n')[0].includes('\t')?parseCsv(text):text;
}
