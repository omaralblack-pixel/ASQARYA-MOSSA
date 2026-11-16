import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import {zipSync} from 'fflate';

const cache=new Map();
function module(file){
 file=resolve(file);
 if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const source=fs.readFileSync(file,'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 new Function('exports','require',js)(exports,name=>name.startsWith('.')?module(resolve(dirname(file),name+'.ts')):createRequire(file)(name));
 return exports;
}
const {decodeArchivedSapSource,archivedXlsxToTsv}=module('app/lib/sap-source-integrity.ts');
const {auditInstitutionReference}=module('app/lib/reference-audit.ts');
const encoder=new TextEncoder();
const bytes=string=>encoder.encode(string);

assert.equal(decodeArchivedSapSource(bytes('Code\tQuantity\nA\t2'),'data.txt'),'Code\tQuantity\nA\t2');
assert.equal(decodeArchivedSapSource(bytes('Code,Quantity\nA,2'),'data.csv'),'Code\tQuantity\nA\t2');
const utf16le=new Uint8Array([0xff,0xfe,...Buffer.from('A\tB\n1\t2','utf16le')]);
assert.equal(decodeArchivedSapSource(utf16le,'data.tsv'),'A\tB\n1\t2');
const files={
 'xl/workbook.xml':'<workbook><sheets><sheet name="Main" sheetId="1" r:id="rId1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/sharedStrings.xml':'<sst><si><t>رقم الصنف</t></si></sst>',
 'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Tom &amp; Jerry</t></is></c><c r="C1"><v>2</v></c></row></sheetData></worksheet>',
};
const xlsx=zipSync(Object.fromEntries(Object.entries(files).map(([name,data])=>[name,bytes(data)])));
assert.equal(archivedXlsxToTsv(xlsx),'رقم الصنف\tTom & Jerry\t2');
assert.equal(decodeArchivedSapSource(xlsx,'source.xlsx'),'رقم الصنف\tTom & Jerry\t2');
assert.throws(()=>archivedXlsxToTsv(bytes('not-zip')));
const ref=JSON.parse(fs.readFileSync('app/reference.json','utf8'));
const audit=auditInstitutionReference(ref);
assert.equal(audit.missingPrices.length,6);
assert.deepEqual(audit.packDifferences.map(row=>row.sapCode).sort(),['CHS00596','CHS00620']);
assert.equal(audit.packDifferences.find(row=>row.sapCode==='CHS00620').invoicePack,45);
assert.equal(audit.packDifferences.find(row=>row.sapCode==='CHS00620').cartonPieces,32);
assert.equal(audit.packDifferences.find(row=>row.sapCode==='CHS00596').invoicePack,48);
assert.equal(audit.packDifferences.find(row=>row.sapCode==='CHS00596').cartonPieces,50);
assert.equal(JSON.stringify(ref),fs.readFileSync('app/reference.json','utf8').trim(),
 'Read-only reference audit must never rewrite the source catalog');
console.log('PASS: original TXT/CSV/UTF-16/XLSX decoding and read-only reference pack/price audit.');
