'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw,Wifi,WifiOff} from 'lucide-react';
import type {ProjectSyncEvent,ProjectSyncScope} from '../app/lib/project-sync-core';

type Scope=ProjectSyncScope|'all';
type SyncSignal={version:number;scope:Scope};
const INTERVAL_MS=6000;

export function useInstitutionSync(){
 const cursor=useRef<number|null>(null);
 const active=useRef(false);
 const requestActive=useRef(false);
 const [signal,setSignal]=useState<SyncSignal>({version:0,scope:'all'});
 const [checkedAt,setCheckedAt]=useState('');
 const [error,setError]=useState('');
 const [checking,setChecking]=useState(false);
 const poll=useCallback(async(force=false)=>{
  if(requestActive.current)return false;
  requestActive.current=true;
  if(force)setChecking(true);
  try{
   const response=await fetch('/api/project-sync?limit=100',{cache:'no-store'});
   if(!response.ok)throw Error(response.status===401?'انتهت جلسة الدخول؛ سجّل الدخول مجددًا.':
    'تعذّر الوصول لمركز المزامنة (HTTP '+response.status+').');
   const data=await response.json() as {revision:number;events:ProjectSyncEvent[]};
   if(!Number.isSafeInteger(data.revision)||!Array.isArray(data.events))
    throw Error('رد مركز المزامنة غير مكتمل.');
   if(cursor.current!==null&&data.revision>cursor.current){
    const events=data.events.filter(event=>event.id>cursor.current!);
    const scopes=new Set(events.map(event=>event.scope));
    const earliest=Math.min(...data.events.map(event=>event.id));
    const missed=events.length===0||Number.isFinite(earliest)&&earliest>cursor.current+1;
    const scope:Scope=!missed&&scopes.size===1?[...scopes][0]:'all';
    setSignal(old=>({version:old.version+1,scope}));
   }
   cursor.current=data.revision;
   if(force)setSignal(old=>({version:old.version+1,scope:'all'}));
   setError('');setCheckedAt(new Date().toISOString());
   return true;
  }catch(cause){
   setError(cause instanceof Error?cause.message:'توقفت المزامنة التلقائية.');
   return false;
  }finally{
   requestActive.current=false;
   if(force)setChecking(false);
  }
 },[]);
 useEffect(()=>{
  active.current=true;
  void poll();
  const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void poll();},INTERVAL_MS);
  const onResume=()=>{if(document.visibilityState==='visible')void poll();};
  window.addEventListener('focus',onResume);
  document.addEventListener('visibilitychange',onResume);
  let broadcast:BroadcastChannel|null=null;
  if(typeof BroadcastChannel!=='undefined'){
   broadcast=new BroadcastChannel('institution-project-updates');
   broadcast.onmessage=()=>{if(active.current)void poll()};
  }
  const onLocal=()=>{broadcast?.postMessage({event:'changed'});void poll()};
  window.addEventListener('institution:sync-now',onLocal);
  return()=>{
   active.current=false;window.clearInterval(timer);
   window.removeEventListener('focus',onResume);
   document.removeEventListener('visibilitychange',onResume);
   window.removeEventListener('institution:sync-now',onLocal);
   broadcast?.close();
  };
 },[poll]);
 return {signal,checkedAt,error,checking,refreshNow:()=>poll(true)};
}
/** Called only once a backend write has returned success. Never claim a
 * remote database update before the server confirms it. */
export function announceInstitutionChange(){
 if(typeof window!=='undefined')window.dispatchEvent(new Event('institution:sync-now'));
}

export function ProjectSyncIndicator({checkedAt,error,checking,onRefresh}:{
 checkedAt:string;error:string;checking:boolean;onRefresh:()=>void;
}){
 return <div className="panel no-print" role="status" aria-live="polite"
   style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,
    padding:'10px 14px',marginBottom:12,flexWrap:'wrap'}}>
  <div style={{display:'flex',gap:8,alignItems:'center'}}>
   {error?<WifiOff size={18}/>:<Wifi size={18}/>}
   <div><strong>{error?'المزامنة بحاجة متابعة':checkedAt?'المزامنة التلقائية تعمل':'جارٍ الاتصال بمركز المزامنة'}</strong>
    <small style={{display:'block'}}>{error||(
     checkedAt?'آخر تحقق ناجح: '+new Date(checkedAt).toLocaleTimeString('ar-JO',{timeZone:'Asia/Amman'}):
      'يتم فحص التغييرات المشتركة تلقائيًا')}
    </small></div>
  </div>
  <button type="button" className="button secondary small" onClick={onRefresh} disabled={checking}>
   <RefreshCw size={15}/> {checking?'جارٍ التحديث…':'تحديث الآن'}
  </button>
 </div>;
}
