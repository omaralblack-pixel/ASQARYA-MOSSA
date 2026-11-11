import {initialAuditCatalog,validateAuditCatalog,type AuditCatalog} from '../../lib/audit-catalog';
import {collectInvoicesByDate} from '../../lib/invoice-collector';
import {isHistoricalSoldierRecord} from '../../lib/soldier-start';
import {env} from 'cloudflare:workers';
import defaults from '../../reference.json';
import schemaStatements from '../../lib/reconciliation-schema.json';
import branches from '../../branches.json';
import drivers from '../../drivers.json';
import {reconcile,prepareReconciliation,withInvoiceDates,sapReferences,documentNo,invoiceDocumentNo,dateValue,parseTransfer,transferNumbers,type Draft,type Item,type TransferSource} from '../../lib/reconcile';
export const dynamic='force-dynamic';
const json=(v:any,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const db=()=>{if(!env.DB)throw Error('قاعدة البيانات غير متاحة');return env.DB};
async function refs():Promise<Item[]>{const r=await db().prepare('SELECT value FROM settings WHERE key=?').bind('reconciliationReference').first();return r?JSON.parse(String(r.value)):defaults as Item[]}
// Initialize only missing tables on standalone Cloudflare deployments.
let schemaReady:Promise<unknown>|undefined;
function ensureSchema(){return schemaReady??=db().batch(schemaStatements.map(sql=>db().prepare(sql))).catch(error=>{schemaReady=undefined;throw error})}
// The previously stored catalog remains read-only input for invoice page sorting.
async function currentPageSortingCatalog():Promise<AuditCatalog>{
 const row=await db().prepare('SELECT value FROM settings WHERE key=?')
   .bind('institutionAuditCatalog').first<{value:string}>();
 if(!row)return initialAuditCatalog(await refs());
 const saved=JSON.parse(row.value) as {catalog:AuditCatalog};
 if(!validateAuditCatalog(saved.catalog))throw Error('مرجع فرز الصفحات المحفوظ غير صالح.');
 return saved.catalog;
}
export async function GET(req:Request){try{await ensureSchema();const u=new URL(req.url);if(u.searchParams.has('lieutenant')){
 const [records,queue]=await Promise.all([
  db().prepare('SELECT id,branch,status,payload FROM reconciliations ORDER BY updated DESC').all(),
  db().prepare('SELECT transfer_no,doc_date,payload,source_file,created FROM lieutenant_queue ORDER BY doc_date,transfer_no').all(),
 ]);
 return json({records:records.results,queue:queue.results});
}if(u.searchParams.has('pageSortingCatalog')){
 return json({catalog:await currentPageSortingCatalog()});
}if(u.searchParams.has('invoiceListFrom')||u.searchParams.has('invoiceListTo')){
 const from=u.searchParams.get('invoiceListFrom')||'';
 const to=u.searchParams.get('invoiceListTo')||'';
 const records=await db().prepare('SELECT id,branch,status,doc_date,payload FROM reconciliations ORDER BY updated DESC')
   .all<{id:string;branch:string;status:string;doc_date:string;payload:string}>();
 try{return json(collectInvoicesByDate(records.results,from,to))}
 catch(error){return json({error:error instanceof Error?error.message:'الفترة غير صالحة.'},400)}
}if(u.searchParams.has('id')){const r=await db().prepare('SELECT * FROM reconciliations WHERE id=?').bind(u.searchParams.get('id')).first();return r?json({record:r}):json({error:'السجل غير موجود'},404)}if(u.searchParams.has('transfer'))return await findSavedTransfer((u.searchParams.get('transfer')||'').trim()); if(u.searchParams.has('export')){const r=await db().prepare('SELECT id,branch,doc_date,status,payload FROM reconciliations ORDER BY updated DESC').all();return json({records:r.results})} if(u.searchParams.has('records')){const r=await db().prepare(`SELECT id,branch,driver,doc_date,status,created,updated,version,json_object('summary',json(json_extract(payload,'$.summary')),'transfers',json((SELECT json_group_array(json_object('number',json_extract(value,'$.number'),'date',json_extract(value,'$.date'))) FROM json_each(payload,'$.transfers'))),'invoices',json((SELECT json_group_array(json_object('number',json_extract(value,'$.number'),'complete',json(CASE WHEN json_extract(value,'$.complete')=1 THEN 'true' ELSE 'false' END),'date',json_extract(value,'$.date'),'amount',json_extract(value,'$.amount'))) FROM json_each(payload,'$.invoices')))) AS payload FROM reconciliations ORDER BY updated DESC`).all();return json({records:r.results})}const settings=await db().prepare("SELECT key,value FROM settings WHERE key IN ('branches','drivers')").all();const shared=Object.fromEntries((settings.results as any[]).map(r=>[r.key,JSON.parse(r.value)]));return json({reference:await refs(),branches:shared.branches||branches,drivers:shared.drivers||drivers})}catch{return json({error:'تعذّر تحميل البيانات. أعد المحاولة.'},500)}}
type StoredReconciliation = {
  id: string;
  branch: string;
  payload: string;
  version: number;
  created: string;
};

async function findSavedTransfer(number: string) {
  if(!/^\d{4,20}$/.test(number))return json({error:'رقم الترحيل غير صالح'},400);
  // Older records can store several transfer numbers in one card.
  const {results} = await db().prepare(`
    SELECT r.id, r.branch, r.version, r.payload FROM reconciliations r
    WHERE EXISTS (
      SELECT 1 FROM json_each(r.payload, '$.transfers') t
      WHERE instr('+' || replace(replace(replace(replace(json_extract(t.value, '$.number'), '،', '+'), ' ', ''), ',', ''), '٬', '') || '+', '+' || ? || '+') > 0
    )
    LIMIT 2
  `).bind(number).all<StoredReconciliation>();
  if (results.length > 1) return json({error: 'رقم الترحيل مكرر في السجل. راجع الترحيل قبل إضافته.'}, 409);
  const record = results[0];
  if (!record) return json({error: 'رقم الترحيل غير موجود في السجل.'}, 404);
  const draft = JSON.parse(record.payload) as Draft;
  const transfer = draft.transfers.find(row => transferNumbers(row.number).includes(number));
  if (!transfer) return json({error: 'بيانات الترحيل غير متاحة.'}, 404);
  return json({
    transfer,
    invoiceNumbers: draft.invoices.map(invoice => invoiceDocumentNo(invoice.number)).filter(Boolean),
    recordId: record.id,
    version: record.version,
    branch: record.branch,
  });
}

function summarize(result: ReturnType<typeof reconcile>) {
  const acceptedDifference = 'acceptedDifference' in result && result.acceptedDifference === true;
  return {
    status: result.status, acceptedDifference, total: result.total, expected: result.expected,
    priceDifference: result.priceDifference, differences: result.differences, review: result.review,
  };
}

async function saveReconciliation(d: Draft, requestedSources: unknown = []) {
  const branchSetting = await db().prepare('SELECT value FROM settings WHERE key=?').bind('branches').first();
  const allowedBranches = branchSetting ? JSON.parse(String(branchSetting.value)) : branches;
  if (!d || !Array.isArray(d.transfers) || !d.transfers.length || d.transfers.length > 30 ||
      !Array.isArray(d.invoices) || !d.invoices.length || d.invoices.length > 30 ||
      !allowedBranches.includes(d.branch) || typeof d.driver !== 'string' || d.driver.length > 120 ||
      !dateValue(d.date) || typeof d.notes !== 'string' || d.notes.length > 5000) {
    return json({error: 'أكمل الفرع والتاريخ وبيانات الترحيل والفاتورة.'}, 400);
  }
  if ((d.mode !== undefined && d.mode !== 'manual') ||
      (d.checks !== undefined && (!d.checks || typeof d.checks !== 'object' || Array.isArray(d.checks) ||
        Object.keys(d.checks).length > 500 || Object.values(d.checks).some(check =>
          !check || typeof check.signature !== 'string' || check.signature.length > 200000 ||
          !['match', 'difference'].includes(check.state) ||
          (check.note !== undefined && (typeof check.note !== 'string' || check.note.length > 1000)))))) {
    return json({error: 'بيانات التشييك غير صالحة.'}, 400);
  }

  if(d.soldierLineAllocations!==undefined&&(!d.soldierLineAllocations||
      typeof d.soldierLineAllocations!=='object'||Array.isArray(d.soldierLineAllocations)||
      Object.keys(d.soldierLineAllocations).length>3000||
      Object.entries(d.soldierLineAllocations).some(([key,values])=>
        !/^l:[^:]{1,120}:\d+:[A-Z]{2,6}\d{3,10}$/.test(key)||
        !values||typeof values!=='object'||Array.isArray(values)||
        Object.keys(values).length>30||
        Object.entries(values).some(([page,qty])=>!/^\d{1,2}$/.test(page)||
          !Number.isFinite(qty)||typeof qty!=='number'||qty<=0||qty>100000000))))return json({error:'توزيع بنود الجندي على الفواتير غير صالح.'},400);
  if(d.soldierManualLineKeys!==undefined&&(!Array.isArray(d.soldierManualLineKeys)||
    d.soldierManualLineKeys.length>3000||d.soldierManualLineKeys.some(key=>typeof key!=='string'||key.length>180)))
    return json({error:'اعتمادات فرز الصفحات غير صالحة.'},400);
  const ts = d.transfers.map(transfer => documentNo(String(transfer?.number ?? '')));
  const ns = d.invoices.map(invoice => documentNo(String(invoice?.number ?? '')));
  const invoiceNumbers = ns.map(invoiceDocumentNo).filter(Boolean);
  if (ts.some(number => !number || number.length > 80) ||
      ns.some((number, index) => number.length > 80 || (!invoiceDocumentNo(number) && d.invoices[index]?.complete)) ||
      new Set(invoiceNumbers).size !== invoiceNumbers.length ||
      d.transfers.some(transfer => !transfer || !dateValue(transfer.date) || typeof transfer.paste !== 'string' || transfer.paste.length > 500000) ||
      d.invoices.some(invoice => !invoice ||
        (invoice.title !== undefined && (typeof invoice.title !== 'string' || invoice.title.length > 80)) ||
        typeof invoice.amount !== 'string' || invoice.amount.length > 30 || typeof invoice.complete !== 'boolean' ||
        (invoice.auditLines !== undefined && (typeof invoice.auditLines !== 'string' || invoice.auditLines.length > 30000)) ||
        (invoice.sapInstitutionChoices !== undefined && (!invoice.sapInstitutionChoices ||
          typeof invoice.sapInstitutionChoices !== 'object'||Array.isArray(invoice.sapInstitutionChoices)||
          Object.keys(invoice.sapInstitutionChoices).length>100||
          Object.entries(invoice.sapInstitutionChoices).some(([sap,code])=>
            !/^[A-Z]{2,6}\d{3,10}$/.test(sap)||typeof code!=='string'||!/^\d{8}$/.test(code)))) ||
        !invoice.quantities || typeof invoice.quantities !== 'object' || Array.isArray(invoice.quantities) ||
        Object.keys(invoice.quantities).length > 500 ||
        Object.values(invoice.quantities).some(value => typeof value !== 'string' || value.length > 40) ||
        (invoice.date && !dateValue(invoice.date)))) {
    return json({error: 'راجع أرقام المستندات والتواريخ والفواتير الورقية.'}, 400);
  }

  const transferKeys = ts.flatMap(transferNumbers);
  if (transferKeys.length !== new Set(transferKeys).size) return json({error: 'رقم الترحيل مكرر في هذا الكشف.'}, 400);
  if (transferKeys.length > 1 && !invoiceNumbers.length) {
    return json({error: 'اكتب رقم الفاتورة الزرقاء قبل حفظ أكثر من ترحيل معًا.'}, 400);
  }

  const id = d.id || crypto.randomUUID();
  const old = d.id ? await db().prepare('SELECT * FROM reconciliations WHERE id=?').bind(id).first<StoredReconciliation>() : null;
  if (d.id && !old) return json({error: 'السجل غير موجود.'}, 404);
  if (old && old.version !== d.version) return json({error: 'عُدّل الكشف في جلسة أخرى. افتحه مجددًا قبل الحفظ.'}, 409);
  const previous = old ? JSON.parse(old.payload) as Draft : undefined;
  for (const invoice of previous?.invoices ?? []) {
    if (!invoice.manualNumber || !invoice.number) continue;
    const incoming = d.invoices.find(row => row.id === invoice.id);
    if (incoming && documentNo(incoming.number) !== documentNo(invoice.number) && !incoming.manualNumber) {
      return json({error: 'عدّل رقم الفاتورة الزرقاء يدويًا. الاستيراد لا يغيّر الرقم الذي صحّحته.'}, 409);
    }
  }

  // The lookup supplies a version for each previously saved transfer. Move only
  // the requested cards, and recheck that their records still have no invoice.
  if (!Array.isArray(requestedSources) || requestedSources.length > d.transfers.length ||
      requestedSources.some(source => !source || typeof source.number !== 'string' ||
        !/^\d{4,20}$/.test(source.number) || !transferKeys.includes(source.number) ||
        typeof source.recordId !== 'string' || !source.recordId || source.recordId === id ||
        source.recordId.length > 100 || !Number.isInteger(source.version) || source.version < 1)) {
    return json({error: 'أعد البحث عن الترحيل قبل حفظه.'}, 400);
  }
  const claims = requestedSources as TransferSource[];
  if (new Set(claims.map(source => source.number)).size !== claims.length ||
      (claims.length && (!invoiceNumbers.length || claims.some(source => transferNumbers(ts[0]).includes(source.number))))) {
    return json({error: 'افتح الترحيل الأول واكتب رقم فاتورته الزرقاء قبل حفظ الترحيل المضاف.'}, 400);
  }

  const sourceIds = [...new Set(claims.map(source => source.recordId))];
  const sourceRecords = sourceIds.length
    ? (await db().prepare('SELECT * FROM reconciliations WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(sourceIds)).all<StoredReconciliation>()).results
    : [];
  const sources = sourceRecords.map(record => ({
    record,
    draft: JSON.parse(record.payload) as Draft,
    numbers: claims.filter(source => source.recordId === record.id).map(source => source.number),
  }));
  if (sourceRecords.length !== sourceIds.length ||
      claims.some(source => sourceRecords.find(row => row.id === source.recordId)?.version !== source.version)) {
    return json({error: 'تغيّر سجل أحد الترحيلات المضافة. احذفه من الكشف وأعد إضافته للتحقق.'}, 409);
  }

  const sourceByNumber = new Map<string, string>();
  for (const source of sources) {
    const invoice = source.draft.invoices.map(row => invoiceDocumentNo(row.number)).find(Boolean);
    if (invoice) return json({error: 'الترحيل ' + source.numbers[0] + ' مرتبط بالفاتورة الزرقاء ' + invoice + '.'}, 409);
    for (const number of source.numbers) {
      const saved = source.draft.transfers.find(row => transferNumbers(row.number).includes(number));
      const index = ts.findIndex(value => transferNumbers(value).includes(number));
      if (!saved || transferNumbers(saved.number).length !== 1 || transferNumbers(ts[index]).length !== 1) {
        return json({error: 'بنود الترحيل ' + number + ' محفوظة مع أرقام أخرى في جدول واحد. يلزم فصل الجدول أولًا.'}, 409);
      }
      if (!parseTransfer(d.transfers[index].paste, {allowReverse: true}).lines.length) {
        return json({error: 'أدخل بنود SAP للترحيل ' + number + ' قبل الحفظ.'}, 400);
      }
      sourceByNumber.set(number, source.record.id);
    }
  }

  const prior = await db().prepare("SELECT r.id,json_extract(t.value,'$.number') AS number FROM reconciliations r, json_each(r.payload,'$.transfers') t WHERE r.id<>?")
    .bind(id).all<{id: string; number: string}>();
  const incomingNumbers = new Set(transferKeys);
  for (const row of prior.results) {
    const conflict = transferNumbers(row.number || '').find(number => incomingNumbers.has(number) && sourceByNumber.get(number) !== row.id);
    if (conflict) return json({error: 'الترحيل ' + conflict + ' محفوظ مسبقًا. ابحث عنه من زر «إضافة ترحيل» للتحقق من فاتورته.'}, 409);
  }
  const priorInvoices = await db().prepare("SELECT r.id,json_extract(i.value,'$.number') AS number FROM reconciliations r, json_each(r.payload,'$.invoices') i WHERE r.id<>?")
    .bind(id).all<{id: string; number: string}>();
  const invoiceOwners = new Set(priorInvoices.results.map(row => invoiceDocumentNo(row.number)).filter(Boolean));
  for (const number of invoiceNumbers) {
    if (invoiceOwners.has(number)) return json({error: 'رقم الفاتورة الزرقاء ' + number + ' محفوظ مسبقًا. افتحها لإضافة الترحيل إليها.'}, 409);
    const key = await db().prepare("SELECT group_id FROM invoice_keys WHERE substr(key,instr(key,'|')+1)=? AND group_id<>? LIMIT 1").bind(number, id).first();
    if (key) return json({error: 'رقم الفاتورة الزرقاء ' + number + ' محفوظ مسبقًا.'}, 409);
  }

  const {linkedSapCodes} = d;
  if (linkedSapCodes !== undefined && (!Array.isArray(linkedSapCodes) || linkedSapCodes.length > 500 ||
      linkedSapCodes.some(code => typeof code !== 'string' || !/^[A-Z]{2,6}\d{3,10}$/.test(code)))) {
    return json({error: 'بيانات ربط الأصناف غير صالحة.'}, 400);
  }
  const version = (old?.version ?? 0) + 1;
  const nonce = crypto.randomUUID();
  const now = new Date().toISOString();
  // Page sorting is temporarily paused for normal and instant reconciliation.
  // Preserve any previously approved allocations; do not generate new ones at save.
  const soldierExempt=!!old&&isHistoricalSoldierRecord(old.created);
  const normalized=withInvoiceDates({
    ...d, id, version, referenceSnapshot: previous?.referenceSnapshot,
    transfers: d.transfers.map((transfer, index) => ({...transfer, number: ts[index]})),
    invoices: d.invoices.map((invoice, index) => ({...invoice, number: ns[index]})),
  });
  const sorted={draft:normalized,
    assigned:Object.keys(normalized.soldierLineAllocations||{}).length,
    split:Object.values(normalized.soldierLineAllocations||{}).filter(p=>Object.keys(p).length>1).length,
    unresolved:[] as {sapCode:string;transfer:string;reason:string}[]};
  const prepared = prepareReconciliation(sorted.draft, await refs());
  const reference = prepared.reference;
  const clean = {...prepared.draft, referenceSnapshot: reference, useCurrentReference: false, linkedSapCodes: undefined};
  const summary = summarize(prepared.result);
   const payload = JSON.stringify({...clean, summary, acceptedDifference: summary.acceptedDifference ? d.acceptedDifference : undefined});
  const revisions = JSON.stringify(sourceRecords.map(({id, version}) => ({id, version})));
  const sourcesUnchanged = `NOT EXISTS (
    SELECT 1 FROM json_each(?) expected
    LEFT JOIN reconciliations source ON source.id = json_extract(expected.value, '$.id')
      AND source.version = json_extract(expected.value, '$.version')
    WHERE source.id IS NULL
  )`;
  const guard = 'EXISTS(SELECT 1 FROM reconciliations WHERE id=? AND revision_token=?)';
  const queries: D1PreparedStatement[] = [
    old
      ? db().prepare(`UPDATE reconciliations SET transfer_no=?,branch=?,driver=?,doc_date=?,payload=?,status=?,updated=?,version=?,revision_token=?
          WHERE id=? AND version=? AND ${sourcesUnchanged}`)
          .bind(ts[0], d.branch, d.driver, d.date, payload, summary.status, now, version, nonce, id, old.version, revisions)
      : db().prepare(`INSERT INTO reconciliations(id,transfer_no,branch,driver,doc_date,payload,status,created,updated,version,revision_token)
          SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${sourcesUnchanged}`)
          .bind(id, ts[0], d.branch, d.driver, d.date, payload, summary.status, now, now, version, nonce, revisions),
  ];

  for (const {record, draft, numbers} of sources) {
    const remaining = draft.transfers.filter(row => !transferNumbers(row.number).some(number => numbers.includes(number)));
    queries.push(db().prepare(`INSERT INTO reconciliation_transfer_archive(id,created,destination_id,source_record)
      SELECT ?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(), now, id, JSON.stringify(record), id, nonce));
    if (remaining.length) {
      const updated = withInvoiceDates({...draft, transfers: remaining, version: record.version + 1});
      const remainingSummary = summarize(reconcile(updated, updated.referenceSnapshot ?? reference));
      const remainingPayload = JSON.stringify({
        ...updated, summary: remainingSummary, acceptedDifference: remainingSummary.acceptedDifference ? updated.acceptedDifference : undefined,
      });
      queries.push(db().prepare(`UPDATE reconciliations SET transfer_no=?,payload=?,status=?,updated=?,version=?,revision_token=?
        WHERE id=? AND ${guard}`).bind(remaining[0].number, remainingPayload, remainingSummary.status, now, updated.version, crypto.randomUUID(), record.id, id, nonce));
      queries.push(db().prepare(`DELETE FROM transfer_keys WHERE group_id=? AND key IN (SELECT value FROM json_each(?)) AND ${guard}`)
        .bind(record.id, JSON.stringify(numbers), id, nonce));
    } else {
      queries.push(db().prepare(`DELETE FROM transfer_keys WHERE group_id=? AND ${guard}`).bind(record.id, id, nonce));
      queries.push(db().prepare(`DELETE FROM invoice_keys WHERE group_id=? AND ${guard}`).bind(record.id, id, nonce));
      queries.push(db().prepare(`DELETE FROM reconciliations WHERE id=? AND ${guard}`).bind(record.id, id, nonce));
    }
  }

  for (const [table, keys] of [['transfer_keys', transferKeys], ['invoice_keys', invoiceNumbers.map(n => 'GLOBAL|'+n)]] as const) {
    queries.push(db().prepare(`DELETE FROM ${table} WHERE group_id=? AND ${guard}`).bind(id, id, nonce));
    queries.push(db().prepare(`INSERT INTO ${table}(key,group_id) SELECT value,? FROM json_each(?) WHERE ${guard}`)
      .bind(id, JSON.stringify(keys), id, nonce));
  }

  try {
    const [saved] = await db().batch(queries);
    if (!saved.meta.changes) {
      return json({error: 'تغيّر أحد الترحيلات أثناء الحفظ. حدّث الكشف وأعد المحاولة.'}, 409);
    }
  } catch {
    return json({error: 'تعارض في أرقام الفواتير أو الترحيلات. راجع المستندات وأعد المحاولة.'}, 409);
  }
  return json({id, version, referenceSnapshot: reference, summary,
    pageSorting:{assigned:sorted.assigned,split:sorted.split,exemptedHistorical: soldierExempt,paused:true,
      unresolved:sorted.unresolved.map(row=>({sapCode:row.sapCode,transfer:row.transfer,reason:row.reason}))},
    pages:prepared.draft.pages,soldierLineAllocations:prepared.draft.soldierLineAllocations,
    soldierLineTotals:prepared.draft.soldierLineTotals,soldierManualLineKeys:prepared.draft.soldierManualLineKeys});
}

export async function POST(req:Request){try{if(req.headers.get('origin')!==new URL(req.url).origin)return json({error:'طلب غير مسموح'},403);if(Number(req.headers.get('content-length')||0)>3000000)return json({error:'حجم البيانات كبير'},400);const b:any=await req.json();await ensureSchema();if(b.action==='reference'||b.action==='linkReference'||b.action==='saveReferenceItem'){
const before=await db().prepare('SELECT value FROM settings WHERE key=?').bind('reconciliationReference').first();
const current=before?JSON.parse(String(before.value)) as Item[]:defaults as Item[];
let items=b.items;
if(b.action==='linkReference'){
 const item=b.item as Item;
 if(!item||item.active!==true)return json({error:'أكمل تعريف الصنف قبل الربط'},400);
 const existing=current.find(entry=>entry.code===item.code);
 const occupied=sapReferences(current).find(entry=>entry.sapCode===item.sapCode);
 if(occupied?.active&&occupied.code===item.code)return json({reference:current});
 if(occupied&&(occupied.code!==item.code||occupied.active||existing?.sapCode!==item.sapCode))return json({error:'كود SAP مرتبط مسبقًا. راجع مرجع الأصناف أو حدّث الصفحة.'},409);
 if(existing&&existing.sapCode!==item.sapCode){
  if(!existing.active)return json({error:'فعّل صنف المؤسسة في المرجع قبل إضافة كود SAP آخر.'},409);
  const {sapCode,sapUnit,cartonPieces,kgPerPiece}=item;
  items=current.map(entry=>entry===existing?{...entry,sapAliases:[...(entry.sapAliases||[]),{sapCode,sapUnit,cartonPieces,kgPerPiece}]}:entry);
 }else{
  items=existing?current.map(entry=>entry===existing?{...item,sapAliases:existing.sapAliases}:entry):[...current,item];
 }
}else if(b.action==='saveReferenceItem'){
 const item=b.item as Item;
 if(!item)return json({error:'أكمل تعريف الصنف قبل الحفظ.'},400);
 const existing=current.find(entry=>entry.code===item.code);
 if(JSON.stringify(existing??null)!==JSON.stringify(b.previous))return json({error:'تغيّر تعريف الصنف. افتحه مجددًا لمراجعة التعديل.'},409);
 items=existing?current.map(entry=>entry===existing?item:entry):[...current,item];
}else if(b.previous!==undefined&&JSON.stringify(current)!==JSON.stringify(b.previous)){
 return json({error:'تغيّر مرجع الأصناف. حدّث المرجع وأعد المحاولة.'},409);
}
if(!Array.isArray(items)||items.length<1||items.length>500)return json({error:'قائمة الأصناف غير صالحة'},400);
const codes=new Set<string>(),sap=new Set<string>();
for(const item of items as Item[]){
 if(!item||!/^\d{8}$/.test(item.code)||!item.name?.trim()||item.name.length>350||codes.has(item.code)||typeof item.active!=='boolean'||item.price!==null&&(!Number.isInteger(item.price)||item.price<0||item.price>100000000)||item.sapAliases!==undefined&&(!Array.isArray(item.sapAliases)||item.sapAliases.some(alias=>!alias||typeof alias!=='object')))return json({error:'راجع رقم المؤسسة وتسمية الصنف والسعر.'},400);
 codes.add(item.code);
 for(const entry of [item,...(item.sapAliases||[])]){
  if(!/^[A-Z]{2,6}\d{3,10}$/.test(entry.sapCode)||sap.has(entry.sapCode)||!['Piece','Carton','KG'].includes(entry.sapUnit)||entry.cartonPieces!==null&&(!Number.isInteger(entry.cartonPieces)||entry.cartonPieces<=0||entry.cartonPieces>100000)||entry.kgPerPiece!==null&&(!Number.isFinite(entry.kgPerPiece)||entry.kgPerPiece<=0||entry.kgPerPiece>10000))return json({error:'راجع أكواد SAP والوحدات والشدّات. كل كود SAP يُربط بصنف مؤسسة واحد.'},400);
  sap.add(entry.sapCode);
 }
}
const value=JSON.stringify(items);
const write=before
 ?db().prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(value,'reconciliationReference',before.value)
 :db().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind('reconciliationReference',value);
if(!(await write.run()).meta.changes)return json({error:'تغيّر مرجع الأصناف أثناء الحفظ. أعد المحاولة.'},409);
return json({ok:true,reference:items})}
if (b.action === 'lieutenantImport') {
 const input=b.transfers as unknown;
 const sourceFile=String(b.sourceFile||'');
 if(!/^lieutenant\/[a-z]+__[a-f0-9]{32}__[^/]{1,120}$/.test(sourceFile)||
   !Array.isArray(input)||!input.length||input.length>50)
   return json({error:'احفظ ملف SAP على Supabase أولًا، ثم أرسل دفعة من 1 إلى 50 ترحيلًا.'},400);
 const incoming:{number:string;date:string;paste:string;branch:string;remarks:string;reverse:boolean;cancellationState:string;cancellationMentioned:boolean;invoiceNumbers:string[]}[]=[];
 const seen=new Set<string>();
 for(const row of input){
   const item=row as Record<string,any>;
   const number=String(item?.number||'').trim();
   const date=dateValue(String(item?.date||''));
   const paste=String(item?.paste||'');
   const branch=String(item?.branch||'');
   const remarks=String(item?.remarks||'');
   if(!/^\d{4,20}$/.test(number)||seen.has(number)||!date||!paste||paste.length>100000||
      branch.length>120||remarks.length>2000)
     return json({error:'ترحيل غير صالح أو مكرر داخل الدفعة: '+number},400);
   seen.add(number);
   const lines=paste.replace(/\r/g,'').trim().split('\n');
   if(lines.length<2||lines.length>2000||
     lines[0].replace(/\s/g,'').toLowerCase()!=='itemno.itemdescriptionquantityuomcodefromwarehousetowarehouse')
     return json({error:'أعمدة أصناف SAP غير صالحة في الترحيل '+number},400);
   for(const [i,line] of lines.slice(1).entries()){
     const cells=line.split('\t');
     const qty=Number(String(cells[2]||'').replace(/,/g,''));
     if(cells.length!==6||!/^[A-Z]{2,6}\d{3,10}$/.test(cells[0])||
       !Number.isFinite(qty)||qty<0||qty>100000000||
       !['piece','carton','kg'].includes(String(cells[3]).toLowerCase())||
       !/^\d{3}$/.test(cells[4])||!/^\d{3}$/.test(cells[5])||
       (cells[4]!=='011'&&cells[5]!=='011')||cells[4]===cells[5])
       return json({error:'سطر SAP غير صالح في الترحيل '+number+'، السطر '+(i+2)},400);
   }
   incoming.push({number,date,paste,branch,remarks,reverse:item?.reverse===true,
     cancellationState:['active','canceled','cancellation','unknown'].includes(item?.cancellationState)?item.cancellationState:'unknown',
     cancellationMentioned:item?.cancellationMentioned===true,
     invoiceNumbers:Array.isArray(item?.invoiceNumbers)?
       item.invoiceNumbers.filter((n:unknown)=>typeof n==='string'&&/^\d{10}$/.test(n)).slice(0,30):[]});
 }
 // Scan current reconciliations, not only transfer_keys: old groups can contain several numbers.
 const [groups,queued]=await Promise.all([
   db().prepare('SELECT payload FROM reconciliations').all<{payload:string}>(),
   db().prepare('SELECT transfer_no FROM lieutenant_queue').all<{transfer_no:string}>(),
 ]);
 const existing=new Set<string>(queued.results.map(x=>x.transfer_no));
 for(const row of groups.results){
   let saved:Draft;
   try{saved=JSON.parse(row.payload) as Draft}catch{continue}
   for(const transfer of saved.transfers||[])
     for(const number of transferNumbers(transfer.number||''))existing.add(number);
 }
 const pending=incoming.filter(item=>!existing.has(item.number));
 const queries=pending.map(item=>db().prepare(
   'INSERT OR IGNORE INTO lieutenant_queue (transfer_no,doc_date,payload,source_file,created) VALUES (?,?,?,?,?)'
 ).bind(item.number,item.date,JSON.stringify({
     transfer:{id:'lieutenant-'+item.number,number:item.number,date:item.date,paste:item.paste},
     branch:item.branch,remarks:item.remarks,reverse:item.reverse,cancellationState:item.cancellationState,
     cancellationMentioned:item.cancellationMentioned,invoiceNumbers:item.invoiceNumbers,
   }),sourceFile,new Date().toISOString()));
 const results=queries.length?await db().batch(queries):[];
 const added=results.reduce((count,result)=>count+(result.meta.changes||0),0);
 return json({added,existing:incoming.length-added,total:incoming.length});
 }
 if (b.action === 'save') return await saveReconciliation(b.draft, b.transferSources);
return json({error:'طلب غير معروف'},400)}catch{return json({error:'تعذّر الحفظ. أعد المحاولة.'},500)}}
