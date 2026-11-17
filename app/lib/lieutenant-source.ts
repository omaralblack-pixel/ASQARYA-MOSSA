import {classifyLieutenantContent,parseLieutenantStock,type StockRead} from './lieutenant-stock';
import {isUnifiedSapSource,splitUnifiedSapSource} from './unified-sap-query';
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

export type RestoredDatedStock={file:LieutenantSourceFile;stock:StockRead};
/** Recover dated 011 balances from the *original* complete SAP export when
 * the optional separate opening/closing archives failed to upload. Dates
 * come from the verified WINDOW and stock rows, never upload timestamps.
 * Empty sections are not proof of zero warehouse stock. */
export async function restoreUnifiedStockSnapshots(
 files:LieutenantSourceFile[],from:string,to:string,
 readArchive:(file:LieutenantSourceFile)=>Promise<string>,
):Promise<{opening:RestoredDatedStock|null;closing:RestoredDatedStock|null;issues:string[]}>{
 let opening:RestoredDatedStock|null=null,closing:RestoredDatedStock|null=null;
 const issues:string[]=[];
 const candidates=files.filter(file=>file.kind==='unified'||file.kind==='other')
   .sort((a,b)=>(a.kind==='unified'?0:1)-(b.kind==='unified'?0:1)||
     (b.created||'').localeCompare(a.created||''));
 const seenFingerprints=new Set<string>();
 for(const file of candidates){
   if(opening&&closing?.file.snapshotDate===to)break;
   const fingerprint=file.key.match(/^lieutenant\/(?:unified|other)__([a-f0-9]{32})__/)?.[1]||file.key;
   if(seenFingerprints.has(fingerprint))continue;
   seenFingerprints.add(fingerprint);
   try{
     const text=await readArchive(file);
     if(!isUnifiedSapSource(text))continue;
     const parts=splitUnifiedSapSource(text);
     if(parts.from===from&&parts.counts.OPENING>0&&!opening){
       const stock=parseLieutenantStock(parts.opening,'opening');
       if(stock.items.length)opening={file:{...file,kind:'opening',snapshotDate:parts.from},stock};
     }
     if(parts.to<=to&&parts.counts.CLOSING>0&&(!closing||parts.to>closing.file.snapshotDate!)){
       const stock=parseLieutenantStock(parts.closing,'balance');
       if(stock.items.length)closing={file:{...file,kind:'balance',snapshotDate:parts.to},stock};
     }
   }catch(error){
     issues.push('تعذّر استخراج الأرصدة من '+file.name+': '+(error instanceof Error?error.message:'ملف غير صالح'));
   }
 }
 return {opening,closing,issues};
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
const cancellationReference=/inventory\s+transfer\s+no\.?\s*(\d{4,20})\s+has\s+been\s+cancel(?:ed|led)/ig;
function missingCancellationOriginals(scan:LieutenantScan):string[]{
  const seen=new Set(scan.transfers.map(row=>row.transfer.number));
  const missing=new Set<string>();
  for(const row of scan.transfers){
    for(const match of row.remarks.matchAll(cancellationReference))
      if(!seen.has(match[1]))missing.add(match[1]);
  }
  return [...missing];
}

/** Restore latest SAP archive and non-destructively supplement documents absent
 * from that export using immutable historical archives. This is essential for a
 * date-scoped unified upload: a November export cannot erase October evidence.
 * For duplicate document numbers newest wins; no invoice is created here.
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
    // Never stop after the newest export: it may cover only the selected dates.
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
    if(supplements)restored.name+=' + '+supplements+' ملف SAP أقدم (لاستكمال السجلات التاريخية المفقودة)';
    // The shared legacy export is a supplemental evidence source even when a
    // newer immutable archive exists. Copy only specifically referenced missing
    // originals: never overwrite new documents or import unrelated old rows.
    const missingInArchive=new Set(missingCancellationOriginals(restored.scan));
    if(missingInArchive.size){
      try{
        const shared=await readShared();
        const scan=shared?parse(shared.text):null;
        if(scan){
          const recovered=scan.transfers.filter(row=>missingInArchive.has(row.transfer.number));
          if(recovered.length){
            restored.scan=mergeLieutenantScans(restored.scan,{...scan,transfers:recovered,issues:[]});
            restored.name+=' + '+shared!.name+' (أصول إلغاء مفقودة فقط)';
          }
        }
      }catch{
        restored.scan.issues.push('تعذّرت قراءة كشف SAP المشترك لاستكمال أصول الإلغاء؛ يلزم تحديث المصدر.');
      }
    }
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
