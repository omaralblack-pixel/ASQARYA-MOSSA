import {createHash, randomBytes} from 'node:crypto';

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const ready=new WeakMap<D1Database,Promise<void>>();
export function ensureDesktop(db:D1Database){
 let pending=ready.get(db);
 if(!pending){pending=initialize(db).catch(error=>{ready.delete(db);throw error;});ready.set(db,pending);}
 return pending;
}
async function initialize(db:D1Database){
 await db.batch([
  db.prepare('CREATE TABLE IF NOT EXISTS sap_sync_devices (id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS sap_sync_files (seq INTEGER PRIMARY KEY AUTOINCREMENT,device_id TEXT NOT NULL,sha256 TEXT NOT NULL,file_key TEXT NOT NULL,name TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,saved_at INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,UNIQUE(device_id,sha256))'),
  db.prepare("CREATE TABLE IF NOT EXISTS sap_sync_publication (id INTEGER PRIMARY KEY,token TEXT NOT NULL DEFAULT '',lease INTEGER NOT NULL DEFAULT 0,last_seq INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,shared_key TEXT NOT NULL DEFAULT '',last_saved_at INTEGER NOT NULL DEFAULT 0)") ,
  db.prepare('INSERT OR IGNORE INTO sap_sync_publication(id) VALUES(1)'),
 ]);
 // Additive upgrade for any early staging database; never recreate a table.
 for(const [table,column] of [['sap_sync_files','saved_at'],['sap_sync_publication','last_saved_at']]){
  const columns=await db.prepare('PRAGMA table_info('+table+')').all<{name:string}>();
  if(!columns.results.some(row=>row.name===column)){
   try{await db.prepare('ALTER TABLE '+table+' ADD COLUMN '+column+' INTEGER NOT NULL DEFAULT 0').run();}
   catch(error){if(!(error instanceof Error&&/duplicate column/i.test(error.message)))throw error;}
  }
 }

}
export async function desktopDevice(req:Request,db:D1Database):Promise<string|null>{
 const token=req.headers.get('Authorization')?.match(/^Bearer (sapds_[a-f0-9]{64})$/)?.[1];
 if(!token)return null;
 await ensureDesktop(db);
 const row=await db.prepare('SELECT id FROM sap_sync_devices WHERE token_hash=? AND revoked=0 AND expires>?')
  .bind(createHash('sha256').update(token).digest('hex'),Date.now()).first<{id:string}>();
 return row?.id||null;
}
/** Only the existing signed-in, same-origin gateway may call management. */
export async function manageDesktopDevices(req:Request,db:D1Database){
 await ensureDesktop(db);
 if(req.method==='GET'){
  const rows=await db.prepare('SELECT id,name,expires,revoked,created FROM sap_sync_devices ORDER BY created DESC').all();
  return json({devices:rows.results});
 }
 if(req.method==='POST'){
  const raw=await req.text();if(raw.length>1024)return json({error:'طلب كبير.'},413);
  const body=JSON.parse(raw) as {name?:string};
  if(typeof body.name!=='string'||!body.name.trim()||body.name.length>80)return json({error:'أدخل اسم الجهاز.'},400);
  const token='sapds_'+randomBytes(32).toString('hex'),id=crypto.randomUUID(),expires=Date.now()+90*86400000;
  await db.prepare('INSERT INTO sap_sync_devices(id,name,token_hash,expires,created) VALUES(?,?,?,?,?)')
   .bind(id,body.name.trim(),createHash('sha256').update(token).digest('hex'),expires,new Date().toISOString()).run();
  return json({id,token,expires});
 }
 if(req.method==='DELETE'){
  const id=new URL(req.url).searchParams.get('id')||'';
  await db.prepare('UPDATE sap_sync_devices SET revoked=1 WHERE id=?').bind(id).run();return json({revoked:true});
 }
 return json({error:'Method not allowed'},405);
}
