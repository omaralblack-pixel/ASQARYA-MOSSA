import {classifyLieutenantContent,parseLieutenantStock,type StockRead} from './lieutenant-stock';
import {parseLieutenantTransfers,type LieutenantScan} from './lieutenant';
import type {SavedSapImport} from './saved-sap-import';

export type LieutenantSourceFile={key:string;name:string;kind:string;snapshotDate?:string;created?:string};
export type RestoredLieutenantSource={
  key:string;name:string;scan:LieutenantScan;shared?:SavedSapImport;
};
export const sharedLieutenantKey='shared-sap-current';

/** Only an explicitly dated stock snapshot can be restored automatically.
 * Creation/upload time is deliberately never a substitute for the SAP date. */
export async function restoreLieutenantStock(
  files:LieutenantSourceFile[],kind:'balance'|'opening',cutoff:string,
  readArchive:(file:LieutenantSourceFile)=>Promise<string>,
):Promise<{file:LieutenantSourceFile;stock:StockRead}|null>{
  const candidates=files.filter(file=>file.kind===kind&&file.snapshotDate&&
    /^\d{4}-\d{2}-\d{2}$/.test(file.snapshotDate)&&
    (kind==='opening'?file.snapshotDate===cutoff:file.snapshotDate<=cutoff))
    .sort((a,b)=>b.snapshotDate!.localeCompare(a.snapshotDate!));
  for(const file of candidates){
    const text=await readArchive(file);
    if(classifyLieutenantContent(text)!==kind)continue;
    const stock=parseLieutenantStock(text,kind);
    if(stock.items.length)return {file,stock};
  }
  return null;
}

/** Preserve the newest document version while recovering originals omitted from later
 * SAP exports (for example a canceled Cash Van transfer whose negative correction
 * remains in the newer export). Never add two versions of the same SAP document.
 */
export function mergeLieutenantScans(primary:LieutenantScan,older:LieutenantScan):LieutenantScan{
  const numbers=new Set(primary.transfers.map(row=>row.transfer.number));
  const recovered=older.transfers.filter(row=>!numbers.has(row.transfer.number));
  return {...primary,transfers:[...primary.transfers,...recovered]};
}
const cancellationReference=/inventory\\s+transfer\\s+no\\.?\\s*(\\d{4,20})\\s+has\\s+been\\s+cancel(?:ed|led)/ig;
function missingCancellationOriginals(scan:LieutenantScan):string[]{
  const seen=new Set(scan.transfers.map(row=>row.transfer.number));
  const missing=new Set<string>();
  for(const row of scan.transfers){
    for(const match of row.remarks.matchAll(cancellationReference))
      if(!seen.has(match[1]))missing.add(match[1]);
  }
  return [...missing];
}

/** Restore the newest SAP archive, supplementing only missing original documents
 * referenced by cancellation corrections from older archives. Archive reads never
 * create blue invoices or overwrite the newer version of an SAP document.
 */
export async function restoreLieutenantSource(
  files:LieutenantSourceFile[],branches:string[],
  readArchive:(file:LieutenantSourceFile)=>Promise<string>,
  readShared:()=>Promise<SavedSapImport|undefined>,
):Promise<RestoredLieutenantSource|null>{
  const failures:string[]=[];
  const parse=(text:string)=>{
    if(classifyLieutenantContent(text)!=='transfers')return null;
    const scan=parseLieutenantTransfers(text,branches);
    return scan.transfers.length?scan:null;
  };
  const candidates=files.filter(row=>row.kind==='transfers')
    .sort((a,b)=>(b.created||'').localeCompare(a.created||''));
  let restored:RestoredLieutenantSource|null=null;
  let supplements=0;
  for(const file of candidates){
    if(restored&&!missingCancellationOriginals(restored.scan).length)break;
    try{
      const scan=parse(await readArchive(file));
      if(!scan)continue;
      if(!restored){restored={key:file.key,name:file.name,scan};continue;}
      const merged=mergeLieutenantScans(restored.scan,scan);
      if(merged.transfers.length>restored.scan.transfers.length){
        restored.scan=merged;
        supplements++;
      }
    }catch(cause){failures.push(cause instanceof Error?cause.message:'تعذّر فتح ملف ترحيلات من الأرشيف.');}
  }
  if(restored){
    if(supplements)restored.name+=' + '+supplements+' ملف SAP أقدم (لاستكمال مستندات الإلغاء)';
    const missing=missingCancellationOriginals(restored.scan);
    if(missing.length)restored.scan.issues.push('أصول إلغاء غير موجودة في الملفات المقروءة: '+
      missing.slice(0,12).join('، ')+(missing.length>12?' وغيرها':'')+
      '؛ لا تُعتبر كمياتها مطابقة تلقائيًا.');
    return restored;
  }
  // Legacy installations may have no correctly categorized archive at all.
  try{
    const shared=await readShared();
    if(shared){
      const scan=parse(shared.text);
      if(scan)return {key:sharedLieutenantKey,name:shared.name,scan,shared};
      failures.push('كشف SAP المشترك لا يحتوي ترحيلات 011 قابلة للقراءة.');
    }
  }catch(cause){failures.push(cause instanceof Error?cause.message:'تعذّر تحميل كشف SAP المشترك.');}
  if(failures.length)throw Error([...new Set(failures)].join(' '));
  return null;
}
