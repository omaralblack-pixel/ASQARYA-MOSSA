/** The revision stream is notification-only. The source tables and immutable
 * SAP originals remain the evidence; an event must never alter accounting data. */
export type ProjectSyncScope='reconcile'|'colonel'|'sap'|'aqaba';
export type ProjectSyncEvent={id:number;scope:ProjectSyncScope;method:string;path:string;created_at:string};
export const projectSyncScopes:ProjectSyncScope[]=['reconcile','colonel','sap','aqaba'];
export function projectSyncScope(pathname:string):ProjectSyncScope|null{
 if(pathname==='/api/reconcile'||pathname==='/api/data')return 'reconcile';
 if(pathname==='/api/colonel')return 'colonel';
 if(pathname==='/api/lieutenant-files'||pathname==='/api/sap-processing')return 'sap';
 if(pathname==='/api/aqaba')return 'aqaba';
 return null;
}
export function shouldPublishProjectChange(method:string,path:string,status:number,duplicate=false){
 return ['POST','PUT','PATCH','DELETE'].includes(method)&&status>=200&&status<300&&
   projectSyncScope(path)!==null&&!duplicate;
}
export function affectedScreens(scope:ProjectSyncScope){
 // All open ledgers can contain related decisions. Reload only the mounted
 // screen, not every screen's full project datasets.
 return scope==='aqaba'?['aqaba','lieutenant','reassurance','colonel']:
  scope==='sap'?['sap-files','instant','lieutenant','colonel','reassurance','serial-soldier','monthly','stock']:
  ['reconciliation','instant','colonel','lieutenant','reassurance','serial-soldier','monthly','history','invoices','aqaba'];
}
