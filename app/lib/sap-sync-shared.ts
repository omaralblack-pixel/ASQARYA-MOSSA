/** Merge raw SAP rows by document number, preserving every column and old document.
 * No invoice/quantity/matching decisions are made here. New rows replace the
 * complete old document, never append a second copy of the same document. */
const groups=[
 ['Document Number','DocNum','Doc No','Transfer Number','رقم الترحيل'],
 ['Document Date','DocDate','Posting Date','التاريخ','تاريخ الترحيل'],
 ['Item No.','ItemCode','Item No','كود الصنف','رقم الصنف','رقم المادة'],
 ['Item Description','ItemName','اسم الصنف','وصف الصنف'],
 ['Quantity','الكمية'],['UoM Code','UoM Name','UoM','الوحدة','وحدة المخزون'],
 ['From Warehouse','FromWhsCod','من مستودع','من المستودع'],
 ['To Warehouse','WhsCode','إلى مستودع','الى مستودع','إلى المستودع'],
 ['CANCELED','حالة الإلغاء'],['Branch Code','BranchCode','كود الفرع'],
 ['Branch Name','Branch','اسم الفرع','الفرع'],
];
const normalize=(x:string)=>x.toLowerCase().replace(/[\s._\-:،]+/g,'').trim();
const canonical=(x:string)=>groups.find(g=>g.some(a=>normalize(a)===normalize(x)))?.[0]||x;
function table(text:string){
 const lines=text.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n').filter(x=>x.trim());
 const original=(lines.shift()||'').split('\t').map(canonical);
 const headers=[...new Set(original)];
 const number=headers.indexOf('Document Number');
 if(number<0)throw Error('أعمدة كشف SAP المشترك غير صالحة للدمج الآمن. الأصل محفوظ.');
 const rows=lines.map(line=>{
  const cells=line.split('\t');
  return headers.map(h=>{
   const values=[...new Set(original.flatMap((name,i)=>name===h&&cells[i]?.trim()?[cells[i]]:[]))];
   if(values.length>1)throw Error('أعمدة SAP المتكافئة تحتوي قيمًا متعارضة؛ لم يُستبدل الكشف المشترك.');
   return values[0]||'';
  });
 });
 if(rows.some(row=>!/^\d{4,20}$/.test(row[number]?.trim()||'')))throw Error('كشف SAP يحتوي رقم مستند غير صالح؛ لم يُستبدل الكشف المشترك.');
 return {headers,rows,number};
}
export function mergeSapShared(current:string|undefined,incoming:string):string{
 const next=table(incoming);if(!current)return [next.headers.join('\t'),...next.rows.map(r=>r.join('\t'))].join('\n');
 const old=table(current),numbers=new Set(next.rows.map(row=>row[next.number].trim()));
 const headers=[...next.headers,...old.headers.filter(h=>!next.headers.includes(h))];
 const project=(row:string[],source:string[])=>headers.map(h=>row[source.indexOf(h)]||'').join('\t');
 return [headers.join('\t'),...next.rows.map(r=>project(r,next.headers)),
  ...old.rows.filter(row=>!numbers.has(row[old.number].trim())).map(r=>project(r,old.headers))].join('\n');
}
