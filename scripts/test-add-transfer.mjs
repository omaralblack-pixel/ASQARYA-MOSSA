import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {dirname, resolve} from 'node:path';
import ts from 'typescript';

// Exercise the route and its actual SQL against a disposable SQLite database.
const sql = new DatabaseSync(':memory:');
let beforeBatch;
const env = {DB: {
  prepare(query) {
    const bound = (...values) => ({
      bind: bound,
      async first() { return sql.prepare(query).get(...values) ?? null; },
      async all() { return {results: sql.prepare(query).all(...values)}; },
      async run() { return {meta: sql.prepare(query).run(...values)}; },
    });
    return bound();
  },
  async batch(statements) {
    if (beforeBatch) {
      const change = beforeBatch;
      beforeBatch = undefined;
      change();
    }
    sql.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sql.exec('COMMIT');
      return results;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  },
}};

function loadTs(file) {
  const contents = readFileSync(file, 'utf8');
  const {outputText} = ts.transpileModule(contents, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  });
  const exports = {};
  const require = specifier => {
    if (specifier === 'cloudflare:workers') return {env};
    if (specifier.endsWith('.json')) return createRequire(file)(specifier);
    if (!specifier.startsWith('.')) return createRequire(file)(specifier);
    return loadTs(resolve(dirname(file), specifier + '.ts'));
  };
  new Function('exports', 'require', outputText)(exports, require);
  return exports;
}

const {GET, POST} = loadTs(resolve('app/api/reconcile/route.ts'));
const {addTransferToDraft, checkSignature, reconcile, withInvoiceDates} = loadTs(resolve('app/lib/reconcile.ts'));
const {parseSapImport, canUseSelectedBranchForSapMember} = loadTs(resolve('app/lib/sap-import.ts'));
const {stockReport}=loadTs(resolve('app/lib/stock-report.ts'));
const reference = [{code: '11366443', sapCode: 'FVL00302', name: 'peas', price: 350, cartonPieces: 20, invoicePack: null, sapUnit: 'Carton', kgPerPiece: null, active: true}];
const branch = '1 — Test';
const origin = 'http://localhost';
const apiUrl = origin + '/api/reconcile';
const lookup = number => GET(new Request(apiUrl + '?transfer=' + number));
const save = (draft, transferSources) => POST(new Request(apiUrl, {
  method: 'POST', headers: {origin, 'content-type': 'application/json'},
  body: JSON.stringify({action: 'save', draft, transferSources}),
}));
const read = id => sql.prepare('SELECT * FROM reconciliations WHERE id=?').get(id);
const archives = () => sql.prepare('SELECT * FROM reconciliation_transfer_archive').all();
const header = 'Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const transfer = (number, quantity, date = '2026-11-02', from = '001', to = '011') => ({
  id: number, number, date, paste: header + '\nFVL00302\tpeas\t' + quantity + '\tCarton\t' + from + '\t' + to,
});
const draft = (t, number = '') => ({
  mode: 'manual', branch, driver: 'Driver', date: '2026-11-02',
  transfers: [t], invoices: [{id: 'invoice', number, date: '', amount: '', complete: false, quantities: {}, attachments: []}],
  notes: 'original note',
});
const saved = async input => {
  const response = await save(input);
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return JSON.parse(read(result.id).payload);
};
const claim = async number => {
  const response = await lookup(number);
  assert.equal(response.status, 200);
  const result = await response.json();
  return {transfer: result.transfer, source: {number, recordId: result.recordId, version: result.version}, invoices: result.invoiceNumbers};
};

assert.equal((await lookup('2615834')).status, 404);
sql.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('branches', JSON.stringify([branch]));
sql.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('reconciliationReference', JSON.stringify(reference));

const first = await saved(draft(transfer('2615833', 2)));
const added = await saved(draft(transfer('2615834', 1, '2026-11-01'), '٠'));
const received = await saved(draft(transfer('2615835', 3), '2623014033'));
const openInvoice = withInvoiceDates({...first, notes: 'primary edits', invoices: [{
  ...first.invoices[0], number: '2623014032', amount: '21.000', complete: true, manualNumber: true,
  quantities: {'11366443': '60'}, attachments: [{key: 'paper', name: 'paper.pdf', type: 'application/pdf'}],
}]});
const checked = reconcile(openInvoice, reference).rows[0];
openInvoice.checks = {[checked.key]: {signature: checkSignature(checked), state: 'match'}};
openInvoice.pages = {[checked.key]: '1'};
const pending = await claim('2615834');
assert.deepEqual(pending.invoices, []);
const combined = addTransferToDraft(openInvoice, pending.transfer, branch);
assert.equal(combined.invoices[0].date, '2026-11-01', 'the original invoice date stays tied to the first transfer');
assert.deepEqual(reconcile(combined, reference).rows.map(row => row.transfer), [60]);
assert.equal(read(first.id).version, first.version, 'adding to the open editor does not save it');
assert.ok(read(added.id), 'adding to the editor does not remove the source record');

const numbered = await claim('2615835');
assert.deepEqual(numbered.invoices, ['2623014033']);
const protectedSave = await save(addTransferToDraft(openInvoice, numbered.transfer, branch), [numbered.source]);
assert.equal(protectedSave.status, 409);
assert.match((await protectedSave.json()).error, /2623014033/);
assert.equal((await save({...combined, invoices: first.invoices}, [pending.source])).status, 400);
assert.equal((await save(combined)).status, 409, 'ordinary saves cannot silently take another transfer');
assert.equal(archives().length, 0);

sql.exec(`CREATE TRIGGER force_conflict BEFORE INSERT ON transfer_keys
  WHEN NEW.key = '2615834'
  BEGIN SELECT RAISE(ABORT, 'test conflict'); END;`);
assert.equal((await save(combined, [pending.source])).status, 409);
assert.ok(read(added.id), 'a failed write rolls back removal of the source');
assert.equal(read(first.id).version, first.version);
assert.equal(archives().length, 0);
sql.exec('DROP TRIGGER force_conflict');

beforeBatch = () => sql.prepare('UPDATE reconciliations SET version=version+1 WHERE id=?').run(added.id);
assert.equal((await save(combined, [pending.source])).status, 409, 'a source modified between lookup and commit cannot move');
assert.equal(read(first.id).version, first.version);
assert.ok(read(added.id));
assert.equal(archives().length, 0);
const refreshed = await claim('2615834');
const response = await save(combined, [refreshed.source]);
assert.equal(response.status, 200, (await response.json()).error);
const retained = JSON.parse(read(first.id).payload);
assert.equal(retained.notes, 'primary edits');
assert.deepEqual(retained.invoices[0], combined.invoices[0]);
assert.deepEqual(retained.checks, openInvoice.checks);
assert.deepEqual(retained.pages, openInvoice.pages);
assert.deepEqual(retained.transfers, combined.transfers);
assert.equal(retained.summary.expected, 21000);
assert.equal((await claim('2615834')).source.recordId, first.id);
assert.equal(read(added.id), undefined);
assert.equal(JSON.parse(archives()[0].source_record).payload, JSON.stringify(added));
assert.equal(read(received.id).version, received.version);
assert.equal((await save(combined, [refreshed.source])).status, 409, 'a retry cannot duplicate the transfer');

const noInvoice = draft(transfer('2615840', 1));
const otherCard = transfer('2615841', 2);
const legacy = {...noInvoice, id: 'legacy-unlinked', version: 1, transfers: [...noInvoice.transfers, otherCard]};
const insertLegacy = sql.prepare(`INSERT INTO reconciliations
  (id,transfer_no,branch,driver,doc_date,payload,status,created,updated,version,revision_token)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
insertLegacy.run(legacy.id, legacy.transfers[0].number, branch, '', legacy.date, JSON.stringify(legacy), 'review', '2026-11-02', '2026-11-02', 1, 'original');
const separate = await claim('2615840');
const fresh = addTransferToDraft(draft(transfer('2615842', 1), '2623014034'), separate.transfer, branch);
const savedFresh = await save(fresh, [separate.source]);
assert.equal(savedFresh.status, 200, (await savedFresh.json()).error);
assert.deepEqual(JSON.parse(read(legacy.id).payload).transfers, [otherCard]);
assert.equal(read(legacy.id).transfer_no, otherCard.number);
assert.equal((await claim('2615841')).source.recordId, legacy.id);
assert.equal(JSON.parse(archives()[1].source_record).payload, JSON.stringify(legacy));

const sapHeader = ['رقم الترحيل', 'تاريخ الترحيل', 'كود الفرع', 'اسم الفرع', 'Remarks', ...header.split('\t')].join('\t');
const sapRow = (number, remarks) => [number, '02/11/2026', '1', 'Test', remarks, 'FVL00302', 'peas', '1', 'Carton', '001', '011'].join('\t');
const parsed = parseSapImport([sapHeader, sapRow('2615845', '0000000000'), sapRow('2615846', '2623014035')].join('\n'), [branch]);
assert.deepEqual(parsed.groups.flatMap(group => group.members.map(member => member.invoices)), [[], ['2623014035']]);
assert.equal((await save(addTransferToDraft(draft(transfer('2615844', 1)), parsed.groups[0].members[0].transfer, branch))).status, 400);


// SAP sometimes includes a wrong/blank branch code but a valid branch name.
// An invoice shared by two transfers must still resolve to the same branch.
const institution = '41 — الحارث بن عمير الازدي';
const namedSource = (number, code, name, remarks, date = '02/11/2026') =>
  [number, date, code, name, remarks, 'FVL00302', 'peas', '1', 'Carton', '001', '011'].join('\t');
const institutionRows = [
  sapHeader,
  namedSource('2616175', '41', '', '2641604703 2641604702'),
  namedSource('2616176', '999', '', '2641604702 2641604703'),
  namedSource('2616308', '', '', ''),
  namedSource('2616149', '999', '', ''),
  namedSource('2616401', '999', 'الحارث بن عمير الأزدي', ''),
].join('\n');
const institutionParsed = parseSapImport(institutionRows, [institution]);
const memberByNo = new Map(institutionParsed.groups.flatMap(group =>
  group.members.map(member => [member.transfer.number, member])));
assert.equal(memberByNo.get('2616176').branch, institution, 'shared invoices recover branch unambiguously');
assert.deepEqual(memberByNo.get('2616176').issues, [], 'shared invoice removes false missing branch issue');
assert.equal(memberByNo.get('2616401').branch, institution, 'name fallback applies even if SAP branch code is invalid');
assert.equal(memberByNo.get('2616175').branch, institution);
assert.equal(institutionParsed.groups.find(group=>group.members.some(member=>member.transfer.number==='2616175')).members.length,2,
  'transfers 2616175 and 2616176 sharing both invoices remain in one group');
assert.equal(canUseSelectedBranchForSapMember(memberByNo.get('2616308'),institution),true,
  'an otherwise valid transfer with no branch can use the branch selected by the operator');
assert.equal(canUseSelectedBranchForSapMember(memberByNo.get('2616149'),institution),true);
assert.equal(canUseSelectedBranchForSapMember(memberByNo.get('2616308'),''),false,
  'never guess a branch when the operator has not selected one');
assert.equal(canUseSelectedBranchForSapMember(memberByNo.get('2616175'),institution),false,
  'a recognized branch cannot be overwritten');
assert.equal(canUseSelectedBranchForSapMember({...memberByNo.get('2616308'),issues:['الفرع غير معروف','تاريخ الترحيل غير صالح']},institution),false,
  'other SAP parsing errors must continue blocking additions');
assert.equal(canUseSelectedBranchForSapMember({...memberByNo.get('2616308'),reversal:true},institution),false,
  'canceled SAP documents cannot use the selected branch fallback');
const conflicting = parseSapImport([
  sapHeader,
  namedSource('2616500', '41', '', '2641604703'),
  namedSource('2616501', '42', '', '2641604703'),
  namedSource('2616502', '999', '', '2641604703'),
].join('\n'),[institution,'42 — اربد الشمالي']);
const ambiguous = conflicting.groups.flatMap(group=>group.members).find(member=>member.transfer.number==='2616502');
assert.ok(ambiguous.issues.includes('الفرع غير معروف'),'conflicting invoice branches must not be guessed');

const reverse = transfer('2615847', 0.5, '2026-11-01', '011', '001');
const reverseResult = reconcile(addTransferToDraft(retained, reverse, branch), reference);
assert.equal(reverseResult.rows[0].transfer, 50);

const stockEntry=(number,date,quantity,from,to,code='FVL00302',unit='Carton')=>
  [number,date,'1','Test','',code,'peas',quantity,unit,from,to].join('\t');
const stockText=[
  sapHeader,
  stockEntry('2619000','01/11/2026','10','001','011'),
  stockEntry('2619001','02/11/2026','3','011','001'),
  stockEntry('2619002','02/11/2026','-2','001','011'),
  stockEntry('2619003','03/11/2026','-1','011','001'),
  stockEntry('2619004','04/11/2026','6','002','011'),
  stockEntry('2619004','04/11/2026','2','002','011','FVL00302','Piece'),
  stockEntry('2619005','05/11/2026','90','005','008'),
].join('\n');
const stockFull=stockReport(stockText);
assert.deepEqual([stockFull.from,stockFull.to],['2026-11-01','2026-11-04'],
  'Source period is taken from warehouse transfer document dates involving 011 only');
assert.equal(stockFull.documents,5);
assert.equal(stockFull.codes,1);
assert.equal(stockFull.items.length,2,'Different SAP units must not be combined');
const cartons=stockFull.items.find(row=>row.unit==='كرتونة');
assert.deepEqual([cartons.incoming,cartons.reverse,cartons.cancellation,cartons.net],
  [16,3,-1,12],'Full report keeps incoming - reverse + signed cancellation');
const partial=stockReport(stockText,{from:'2026-11-02',to:'2026-11-03'});
assert.deepEqual([partial.from,partial.to,partial.documents,partial.codes],
  ['2026-11-01','2026-11-04',3,1],
  'Changing selected dates must not alter original file metadata');
assert.deepEqual([partial.items[0].incoming,partial.items[0].reverse,
  partial.items[0].cancellation,partial.items[0].net],[0,3,-1,-4],
  'All directions and both signs of cancellation obey the selected transfer date');
assert.equal(stockReport(stockText,{from:'2026-11-02',to:'2026-11-02'}).items[0].net,-5,
  'Selected starting and ending dates are both inclusive');
assert.equal(stockReport(stockText,{from:'2026-11-03',to:'2026-11-03'}).items[0].net,1);
const april=stockReport(stockText,{from:'2026-11-04',to:'2026-11-04'});
assert.equal(april.documents,1,'Document count is unique across multiple item lines and SAP units');
assert.equal(april.items.length,2);
assert.equal(stockReport(stockText,{from:'2026-11-06',to:'2026-11-11'}).documents,0);
assert.equal(stockReport(stockText,{from:'2026-11-06',to:'2026-11-11'}).items.length,0,
  'Outside-range stock must never be mixed into the selected subtotal');
const stockUI=readFileSync(resolve('app/reconciliation/StockReport.tsx'),'utf8');
assert.ok(stockUI.includes('stockReport(file.text,{from:selectedFrom,to:selectedTo})'),
  'The selected transfer date range must drive the displayed report');
assert.ok(stockUI.includes('report.items.map(row=>[row.sapCode'),
  'Excel export must include the date-filtered report instead of all movements');
assert.ok(stockUI.includes('invalidRange'),'Invalid from/to dates must block report export');

const {tableWorkbook}=loadTs(resolve('app/lib/invoice-workbook.ts'));
const {unzipSync,strFromU8}=createRequire(import.meta.url)('fflate');
const exportRows=[
  ['صافي الترحيلات إلى مستودع 011'],
  ['الفترة المختارة حسب تاريخ الترحيل','2026-11-02 — 2026-11-03'],
  ['الفترة في ملف SAP الأصلي','2026-11-01 — 2026-11-04'],
  ['المصدر','sap-transfer-test.txt'],
  ['مستندات الترحيل في الفترة',partial.documents],
  ['الصافي = الوارد − العكسي + أثر الإلغاء الموقّع'],
  ['كود SAP','اسم الصنف في SAP','الوحدة','الوارد إلى 011','العكسي من 011','أثر الإلغاء','الصافي إلى 011'],
  ...partial.items.map(row=>[row.sapCode,row.name,row.unit,row.incoming,row.reverse,row.cancellation,row.net]),
];
const exportBlob=tableWorkbook(exportRows,'صافي الترحيل 011',[24,68,14,19,19,17,19],7);
assert.ok(exportBlob.size>0,'Excel report must produce a nonempty XLSX Blob');
const exportArchive=unzipSync(new Uint8Array(await exportBlob.arrayBuffer()));
const sheetXml=strFromU8(exportArchive['xl/worksheets/sheet1.xml']);
assert.ok(sheetXml.includes('<autoFilter ref="A7:G'+exportRows.length+'"/>'),
  'Excel header must be at the correct row after report metadata');
assert.ok(sheetXml.includes('<v>-4</v>'),
  'Excel must preserve signed net movements numerically');
assert.ok(sheetXml.includes('2026-11-02 — 2026-11-03'),
  'Excel must state the selected SAP transfer-document date range');
assert.ok(stockUI.includes("import {tableWorkbook} from '../lib/invoice-workbook';"),
  'Stock report must bundle the Excel writer rather than rely on a failing lazy chunk');
assert.ok(stockUI.includes('document.body.appendChild(link)'),
  'Temporary Excel download link must be attached for reliable browser behavior');

console.log('PASS: direct transfer addition, SAP branch recovery, date-filtered stock, cancellation, duplicate guards and atomic rollback');

// A data-entry mistake may be corrected explicitly, without weakening ordinary merge guards.
const wrong = await saved(draft(transfer('2616391', 2), '2632305247'));
const right = await saved(draft(transfer('2616390', 3), '2630806229'));
const moving = await claim('2616391');
const corrected = addTransferToDraft(right, moving.transfer, branch);
assert.equal((await save(corrected, [moving.source])).status, 409);
const correction = {...moving.source, correctInvoice: true, expectedInvoices: ['2632305247']};
assert.equal((await save(corrected, [{...correction, expectedInvoices: ['2632305248']}])).status, 409);
const tampered = {...corrected, transfers: corrected.transfers.map(t=>t.number==='2616391'?{...t,paste:t.paste+'\nFVL00302\tpeas\t1\tCarton\t001\t011'}:t)};
assert.equal((await save(tampered, [correction])).status, 409);
const movedResponse = await save(corrected, [correction]);
assert.equal(movedResponse.status, 200, JSON.stringify(await movedResponse.json()));
assert.equal(read(wrong.id), undefined);
assert.deepEqual(JSON.parse(read(right.id).payload).transfers.map(t=>t.number), ['2616390','2616391']);
assert.equal((await claim('2616391')).source.recordId, right.id);
assert.ok(archives().some(row=>JSON.parse(row.source_record).id===wrong.id));
assert.equal((await save(corrected, [correction])).status, 409, 'stale correction cannot run twice');
console.log('PASS: explicit invoice correction, original transfer integrity, archive and stale-save protection');
