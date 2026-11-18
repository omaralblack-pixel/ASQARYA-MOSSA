'use client';
import {invalidateSavedSapRead} from './saved-sap-import';
import {useSyncExternalStore} from 'react';
let revision=0,timer:ReturnType<typeof setInterval>|undefined,busy=false;
const listeners=new Set<()=>void>();
async function poll(){
 if(busy||document.visibilityState==='hidden')return;busy=true;
 try{
  const response=await fetch('/api/sap-sync-revision',{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok)return;
  const data=await response.json() as {revision:number};
  if(Number.isSafeInteger(data.revision)&&data.revision!==revision){revision=data.revision;invalidateSavedSapRead();listeners.forEach(fn=>fn());}
 }catch{/* Keep last loaded data on an offline browser. */}finally{busy=false;}
}
function subscribe(fn:()=>void){
 listeners.add(fn);
 if(!timer){timer=setInterval(()=>void poll(),15000);window.addEventListener('focus',poll);void poll();}
 return()=>{listeners.delete(fn);if(!listeners.size){clearInterval(timer);timer=undefined;window.removeEventListener('focus',poll);}};
}
/** Rerender SAP readers after a committed publication without reloading a page
 * or replacing unsaved invoice forms. One poll serves all mounted screens. */
export function useSapRevision(){return useSyncExternalStore(subscribe,()=>revision,()=>0);}
