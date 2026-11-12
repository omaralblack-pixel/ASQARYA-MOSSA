import {classifyLieutenantContent,parseLieutenantStock,type StockRead} from './lieutenant-stock';
import {parseLieutenantTransfers,type LieutenantScan} from './lieutenant';
import type {SavedSapImport} from './saved-sap-import';

export type LieutenantSourceFile={key:string;name:string;kind:string;snapshotDate?:string};
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

/** Restore source data only. Reading an archive never queues or approves invoices. */
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
  for(const file of files.filter(row=>row.kind==='transfers')){
    try{
      const scan=parse(await readArchive(file));
      if(scan)return {key:file.key,name:file.name,scan};
    }catch(cause){failures.push(cause instanceof Error?cause.message:'تعذّر فتح ملف ترحيلات من الأرشيف.');}
  }
  // Older uploads use the shared SAP file. A mislabeled balance in the newer
  // archive must not hide that still-valid source or force another upload.
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
