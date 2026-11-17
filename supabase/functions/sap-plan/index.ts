import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {buildSapPlan} from '../../../app/lib/sap-processing.ts';
import {decodeArchivedSapSource} from '../../../app/lib/sap-source-integrity.ts';
import branches from '../../../app/branches.json' with {type:'json'};

// Only the institution Worker can request analysis. This endpoint never writes
// records. D1 remains authoritative for claims, receipts and completed batches.
Deno.serve(async request => {
  const json = (value: unknown, status = 200) => Response.json(value, {status, headers: {'Cache-Control':'no-store'}});
  if (request.method !== 'POST') return json({error:'Method not allowed'},405);
  const timestamp = request.headers.get('x-sap-time') || '';
  const signature = request.headers.get('x-sap-signature') || '';
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now()-Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) return json({error:'Unauthorized'},401);
  const payload = await request.text();
  if (payload.length > 2048) return json({error:'Invalid request'},400);
  const keys = Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')) as string[];
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) keys.push(legacy);
  const secret = keys.find(key => timingSafeEqual(Buffer.from(createHmac('sha256',key).update(timestamp+'\n'+payload).digest('hex')),Buffer.from(signature)));
  if (!secret) return json({error:'Unauthorized'},401);
  try {
    const {key,textHash} = JSON.parse(payload);
    if (typeof key !== 'string' || !/^lieutenant\/(?:transfers|opening|balance|unified|other)__[a-f0-9]{32}__(?:\d{4}-\d{2}-\d{2}__)?[^/\\]{1,120}$/.test(key) || !/^[a-f0-9]{64}$/.test(textHash)) return json({error:'Invalid source'},400);
    const url = Deno.env.get('SUPABASE_URL')+'/storage/v1/object/authenticated/institution-sap/'+key.split('/').map(encodeURIComponent).join('/');
    const original = await fetch(url,{headers:{apikey:secret,Authorization:'Bearer '+secret}});
    if (!original.ok) return json({error:'تعذّر التحقق من الأصل المحفوظ.'},502);
    const wrapped = await original.json();
    if (typeof wrapped.data !== 'string' || wrapped.data.length > 22369640) return json({error:'Invalid archived source'},422);
    const bytes = Buffer.from(wrapped.data,'base64');
    if (!bytes.length || bytes.length !== wrapped.originalSize || createHash('sha256').update(bytes).digest('hex').slice(0,32) !== key.split('__')[1]) return json({error:'بصمة الأصل المحفوظ غير متطابقة.'},409);
    const decoded = decodeArchivedSapSource(bytes,key.split('__').at(-1)!);
    if (createHash('sha256').update(decoded).digest('hex') !== textHash) return json({error:'نص SAP لا يطابق الأصل المحفوظ.'},409);
    return json({plan:buildSapPlan(decoded,branches)});
  } catch {
    return json({error:'تعذّر تحليل أصل SAP؛ راجع تنسيق الملف ثم أعد المحاولة.'},422);
  }
});

