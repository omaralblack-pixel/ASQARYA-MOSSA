import {strToU8, zipSync} from 'fflate';

const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (value: string) => value
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function invoiceWorkbook(rows: string[][]): Blob {
  const values=rows.map(row=>row.map((value,column)=>
    column===7&&/^\d+(?:,\d{3})*\.\d{3}$/.test(value)?Number(value.replace(/,/g,'')):value));
  return tableWorkbook(values, 'سجل فواتير المؤسسة', Array(8).fill(22));
}

export function tableWorkbook(rows: (string|number)[][], name:string, widths:number[], headerRow=1): Blob {
  const sheetRows = rows.map(row => '<row>' + row.map(value =>
    typeof value==='number'
      ? '<c><v>' + value + '</v></c>'
      : '<c t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>'
  ).join('') + '</row>').join('');
  const columns=widths.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join('');
  const lastColumn=String.fromCharCode(64+widths.length);
  const pane=headerRow>1?`<pane ySplit="${headerRow}" topLeftCell="A${headerRow+1}" activePane="bottomLeft" state="frozen"/>`:'';

  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${relationships}"><bookViews><workbookView/></bookViews><sheets><sheet name="${xml(name).replace(/"/g,'&quot;')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheet}"><sheetViews><sheetView workbookViewId="0" rightToLeft="1">${pane}</sheetView></sheetViews><cols>${columns}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A${headerRow}:${lastColumn}${rows.length}"/></worksheet>`,
  };
  const archive = zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])));
  return new Blob([Uint8Array.from(archive)], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
