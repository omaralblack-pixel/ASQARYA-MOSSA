import {sapRequest} from './sap-files-client';
import {readCurrentSapImport} from './approved-sap-client';
import {parseLieutenantTransfers,type LieutenantScan} from './lieutenant';
import {colonelSerialNotes} from './colonel-serial-notes';
import {readReconciliationRecord,transferNumbers} from './reconcile';
import type {CancellationDecision} from './lieutenant-cancellation-decisions';
import type {SerialRecord} from './serial-soldier';

/** Read-only live SAP/lieutenant annotations. If SAP archive is unavailable,
 * explicitly label EVERY project transfer as unverified rather than guessing.
 * Exported invoice/transfer identities still come exclusively from the project.
 */
export async function readColonelNotesForExport(
 branches:string[],records:SerialRecord[],
):Promise<{notes:Map<string,string>;warning:string}>{
 let decisions:CancellationDecision[]=[];
 let decisionWarning='';
 try{
  const response=await sapRequest<{decisions:CancellationDecision[]}>(
   '/api/reconcile?lieutenantCancellationDecisions=1');
  decisions=Array.isArray(response.decisions)?response.decisions:[];
 }catch(cause){
  decisionWarning='تعذّرت قراءة قرارات الملازم: '+(cause instanceof Error?cause.message:'خطأ غير معروف');
 }
 let transfers:{scan:LieutenantScan}|null=null;
 let archiveWarning='';
 try{
  const source=await readCurrentSapImport();
  transfers={scan:parseLieutenantTransfers(source.text,branches)};
  if(!transfers)archiveWarning='لم يوجد كشف SAP محفوظ وقابل للقراءة.';
  else if(transfers.scan.issues.length)
   archiveWarning='كشف SAP يحتوي ملاحظات أو أصول إلغاء ناقصة: '+transfers.scan.issues.slice(0,4).join('؛ ');
 }catch(cause){
  archiveWarning='تعذّرت قراءة كشف SAP: '+(cause instanceof Error?cause.message:'خطأ غير معروف');
 }
 const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',
  month:'2-digit',day:'2-digit'}).format(new Date());
 const notes=colonelSerialNotes(transfers?.scan.transfers||[],decisions,asOf);
 if(archiveWarning||decisionWarning){
  const unverified=[archiveWarning,decisionWarning].filter(Boolean).join(' | ');
  for(const record of records){
   const draft=readReconciliationRecord(record.payload);
   if(!draft)continue;
   for(const number of draft.transfers.flatMap(t=>transferNumbers(t.number||''))){
    notes.set(number,[notes.get(number), 'تنبيه العقيد: '+unverified].filter(Boolean).join(' | '));
   }
  }
 }
 return {notes,warning:[archiveWarning,decisionWarning].filter(Boolean).join(' | ')};
}
