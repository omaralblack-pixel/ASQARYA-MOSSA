import {env} from 'cloudflare:workers';
import type {ProjectSyncEvent} from '../../lib/project-sync-core';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private'};
const schema='CREATE TABLE IF NOT EXISTS institution_sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL)';
let ensurePromise:Promise<unknown>|undefined;
const db=()=>{if(!env.DB)throw Error('قاعدة المؤسسة غير متاحة');return env.DB};
async function ensure(){
 return ensurePromise??=(db().prepare(schema).run().catch(error=>{ensurePromise=undefined;throw error}));
}
/** The gateway already enforces the institution session. Do not add a
 * public sync URL: the cursor and every event belong to the private workspace. */
export async function GET(request:Request){
 try{
  await ensure();
  const limit=Number(new URL(request.url).searchParams.get('limit')||20);
  if(!Number.isInteger(limit)||limit<1||limit>100)
   return Response.json({error:'حد سجل التغييرات غير صالح.'},{status:400,headers});
  const [revision,events]=await Promise.all([
    db().prepare('SELECT COALESCE(MAX(id),0) AS value FROM institution_sync_events').first<{value:number}>(),
    db().prepare('SELECT id,scope,method,path,created_at FROM institution_sync_events ORDER BY id DESC LIMIT ?')
      .bind(limit).all<ProjectSyncEvent>(),
  ]);
  return Response.json({revision:Number(revision?.value||0),events:events.results},{headers});
 }catch(cause){
  console.error('Institution sync state unavailable',cause);
  return Response.json({error:'المزامنة غير متاحة؛ لم يُثبت اتصال مركز التغييرات. حاول التحديث مرة أخرى.'},
    {status:503,headers});
 }
}
