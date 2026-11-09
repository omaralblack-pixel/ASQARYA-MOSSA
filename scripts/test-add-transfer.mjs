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
    return loadTs(resolve(dirname(file), specifier + '.ts'));
  };
  new Function('exports', 'require', outputText)(exports, require);
  return exports;
}

const {GET, POST} = loadTs(resolve('app/api/reconcile/route.ts'));
const {addTransferToDraft, checkSignature, reconcile, withInvoiceDates} = loadTs(resolve('app/lib/reconcile.ts'));
const {parseSapImport} = loadTs(resolve('app/lib/sap-import.ts'));
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

const reverse = transfer('2615847', 0.5, '2026-11-01', '011', '001');
const reverseResult = reconcile(addTransferToDraft(retained, reverse, branch), reference);
assert.equal(reverseResult.rows[0].transfer, 50);
console.log('PASS: direct transfer addition, zero placeholders, protected invoices, retained edits, atomic rollback, legacy records and reverse quantities');
