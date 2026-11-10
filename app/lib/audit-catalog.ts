import seed from './audit-catalog-seed.json';
import official2026 from './official-institution-2026.json';
import confirmedLinks from './confirmed-audit-links.json';
import {digits, numeric, sapReferences, type Item} from './reconcile';

export type SapCatalogRow = {
  code:string; name:string; unit:string; pack:number|null; kg:number|null; institutionCode:string; institutionAliases?:string[];
};
export type InstitutionCatalogRow = {code:string; name:string; price:number|null};
export type AuditCatalog = {sap:SapCatalogRow[]; institution:InstitutionCatalogRow[]; officialSeedVersion?:number; confirmedLinksVersion?:number; sharedInstitutionVersion?:number};
const sapCode = /^[A-Z]{2,6}\d{3,10}$/;
const institutionCode = /^\d{8}$/;
const validName = (name:unknown) => typeof name==='string' && !!name.trim() && name.length<=400;
const validNumber = (n:unknown, limit:number, integer=false) =>
  n===null || typeof n==='number' && Number.isFinite(n) && n>0 && n<=limit && (!integer || Number.isInteger(n));
const seedRows = seed as unknown as Record<string,[string,string,number|null,string,string|null]>;
const officialRows = official2026 as unknown as Record<string,[string,number|null,number]>;
const userConfirmedLinks=confirmedLinks as Record<string,string>;
/**
 * One-time, non-destructive user-approved links.
 * A SAP code already assigned to a different institution item is NOT moved:
 * the conflict must be explicitly reviewed, preserving historic mappings.
 * A missing SAP code is created WITHOUT inventing its description or UoM;
 * audit matching stays blocked until the real SAP UoM is imported.
 */
export function includeConfirmedSapLinks(catalog:AuditCatalog):AuditCatalog{
  if(catalog.confirmedLinksVersion===1)return catalog;
  const sap=new Map(catalog.sap.map(row=>[row.code,row]));
  const institutions=new Set(catalog.institution.map(row=>row.code));
  for(const [code,institutionCode] of Object.entries(userConfirmedLinks)){
    if(!institutions.has(institutionCode))continue;
    const old=sap.get(code);
    if(old){
      if(!old.institutionCode)sap.set(code,{...old,institutionCode});
      continue; // Existing different institution codes are conflicts, never silently reassigned.
    }
    sap.set(code,{code,name:'اسم SAP غير مستورد — '+code,unit:'',pack:null,kg:null,institutionCode});
  }
  return {...catalog,confirmedLinksVersion:1,sap:[...sap.values()]};
}
/**
 * The same SAP SKU can have two legitimate institution item numbers.
 * Keep the original number as the default and add confirmed alternatives.
 * Import only once so a later user edit/removal is not silently undone.
 */
export function includeSharedInstitutionNumbers(catalog:AuditCatalog):AuditCatalog {
  if(catalog.sharedInstitutionVersion===1)return catalog;
  const codes=new Set(catalog.institution.map(row=>row.code));
  const sap=catalog.sap.map(row=>{
    const alternate=userConfirmedLinks[row.code];
    if(!alternate||!codes.has(alternate)||!row.institutionCode||row.institutionCode===alternate)return row;
    if((row.institutionAliases||[]).includes(alternate))return row;
    return {...row,institutionAliases:[...(row.institutionAliases||[]),alternate]};
  });
  return {...catalog,sharedInstitutionVersion:1,sap};
}
export function sharedInstitutionOptions(catalog:AuditCatalog){
  const byCode=new Map(catalog.institution.map(row=>[row.code,row]));
  return catalog.sap.flatMap(row=>{
    const codes=[row.institutionCode,...(row.institutionAliases||[])].filter(code=>byCode.has(code));
    return codes.length>1?[{sapCode:row.code,sapName:row.name,
      codes:codes.map(code=>({code,name:byCode.get(code)!.name,price:byCode.get(code)!.price}))}]:[];
  });
}
/** A per-invoice SAP mapping, without mutating the saved default or other invoices. */
export function catalogAuditReferenceForInvoice(catalog:AuditCatalog,choices:Record<string,string>={}):Item[]{
  const sap=catalog.sap.map(row=>{
    const selected=choices[row.code];
    const allowed=[row.institutionCode,...(row.institutionAliases||[])];
    return selected&&allowed.includes(selected)?{...row,institutionCode:selected}:row;
  });
  return catalogAuditReference({...catalog,sap});
}
/** Conflicts remain visible even after the one-time additive migration. */
export function confirmedSapLinkConflicts(catalog:AuditCatalog){
  const bySap=new Map(catalog.sap.map(row=>[row.code,row]));
  return Object.entries(userConfirmedLinks).flatMap(([code,requested])=>{
    const currentRow=bySap.get(code);
    const current=currentRow?.institutionCode;
    return current&&current!==requested&&!(currentRow?.institutionAliases||[]).includes(requested)
      ?[{code,requested,current}]:[];
  });
}
/**
 * One-time additive import of official blue-invoice item numbers/names.
 * Existing edits, SAP codes, warehouse pack sizes and all approved prices win.
 * The marker prevents deleted definitions being re-created on future loads.
 */
export function includeOfficialInstitution2026(catalog:AuditCatalog):AuditCatalog {
  if(catalog.officialSeedVersion===1)return catalog;
  const known=new Set(catalog.institution.map(row=>row.code));
  const additional=Object.entries(officialRows).filter(([code])=>!known.has(code))
    .map(([code,[name,price]])=>({code,name,price}));
  return {...catalog,officialSeedVersion:1,institution:[...catalog.institution,...additional]};
}
// Each linked institution SKU for these SAP KG rows is sold as one 1 kg bag.
const bagKg:Record<string,number>={PFS00003:1,PFS00179:1,PFS00172:1,PFS00181:1};
const unitOf = (value:string) => ({piece:'Piece',carton:'Carton',kg:'KG'}[value.trim().toLowerCase()]);

export function initialAuditCatalog(reference:Item[]):AuditCatalog {
  const active = reference.filter(item=>item.active);
  const allCodes = new Set(reference.map(item=>item.code));
  const institution = new Map(active.map(item=>[item.code,{
    code:item.code, name:item.sourceName || seedRows[item.sapCode]?.[4] || item.name, price:item.price,
  }]));
  const sap = new Map(sapReferences(active).map(item=>[item.sapCode,{
    code:item.sapCode, name:seedRows[item.sapCode]?.[0] || item.warehouseName || item.name,
    unit:seedRows[item.sapCode]?.[1] || unitOf(item.warehouseUnit || '') || item.sapUnit,
    pack:item.cartonPieces, kg:item.kgPerPiece, institutionCode:item.code,
  }]));
  for(const [code,[name,unit,pack,linked,official]] of Object.entries(seedRows)){
    if(!allCodes.has(linked)&&official)institution.set(linked,{code:linked,name:official,price:null});
    const row=sap.get(code);
    sap.set(code,{
      code,name,unit,pack:pack ?? row?.pack ?? null,kg:row?.kg ?? bagKg[code] ?? null,
      institutionCode:row?.institutionCode || (institution.has(linked)?linked:''),
    });
  }
  return includeSharedInstitutionNumbers(includeConfirmedSapLinks(includeOfficialInstitution2026({sap:[...sap.values()],institution:[...institution.values()]})));

}

export function catalogAuditReference(catalog:AuditCatalog):Item[] {
  const byInstitution = new Map(catalog.institution.map(row=>[row.code,row]));
  const linked = new Map<string,SapCatalogRow[]>();
  for(const row of catalog.sap){
    if(!byInstitution.has(row.institutionCode))continue;
    const rows=linked.get(row.institutionCode) || [];
    rows.push(row);
    linked.set(row.institutionCode,rows);
  }
  return catalog.institution.map(row=>{
    const [first,...aliases]=linked.get(row.code) || [];
    return {
      code:row.code,name:row.name,price:row.price,invoicePack:1,active:true,
      sapCode:first?.code || '',sapUnit:first?.unit ?? '',warehouseName:first?.name,
      cartonPieces:first?.pack ?? null,kgPerPiece:first?.kg ?? null,
      sapAliases:aliases.map(alias=>({
        sapCode:alias.code,sapUnit:alias.unit,cartonPieces:alias.pack,kgPerPiece:alias.kg,
      })),
    };
  });
}

export function validateAuditCatalog(value:unknown):value is AuditCatalog {
  if(!value || typeof value!=='object')return false;
  const {sap,institution}=value as AuditCatalog;
  if(!Array.isArray(sap)||sap.length>1000||!Array.isArray(institution)||institution.length>1000)return false;
  const unique=(rows:{code:string}[])=>new Set(rows.map(row=>row.code)).size===rows.length;
  return sap.every(row=>row && typeof row.code==='string' && sapCode.test(row.code) &&
    validName(row.name) && ['','Piece','Carton','KG'].includes(row.unit) &&
    validNumber(row.pack,10000,true) && validNumber(row.kg,10000) &&
    typeof row.institutionCode==='string' && (!row.institutionCode || institutionCode.test(row.institutionCode)) &&
    (row.institutionAliases===undefined||Array.isArray(row.institutionAliases)&&
      row.institutionAliases.length<=15&&new Set(row.institutionAliases).size===row.institutionAliases.length&&
      row.institutionAliases.every(code=>typeof code==='string'&&institutionCode.test(code)&&
        code!==row.institutionCode&&institution.some(item=>item.code===code)))) &&
    institution.every(row=>row && typeof row.code==='string' && institutionCode.test(row.code) &&
      validName(row.name) && (row.price===0 || validNumber(row.price,100000000,true))) &&
    unique(sap) && unique(institution);
}

const header = (s:string) => s.replace(/^\uFEFF/,'').toLowerCase().replace(/[\s._-]/g,'');
const columns = (cells:string[], names:string[]) => cells.findIndex(cell=>names.includes(header(cell)));

export function importAuditSap(input:string, catalog:AuditCatalog):AuditCatalog {
  const lines=input.trim().split(/\r?\n/);
  const headers=lines[0].split('\t');
  const codeIndex=columns(headers,['itemno','itemcode','كودsap']);
  const nameIndex=columns(headers,['itemdescription','description','اسمsap']);
  const unitIndex=columns(headers,['uomcode','uomname','uom','وحدةsap']);
  const packIndex=columns(headers,['cartonpieces','pack','شدّةsap','شدةsap','حباتكرتونةsap']);
  const kgIndex=columns(headers,['kgperpiece','وزنالحبة']);
  const institutionIndex=columns(headers,['institutioncode','رقمالمؤسسة','رقمالمادةبالمؤسسة']);
  const hasHeaders=codeIndex>=0;
  if(hasHeaders && (nameIndex<0 || unitIndex<0))throw Error('أضف أعمدة اسم SAP ووحدته إلى الجدول.');
  const rows=new Map(catalog.sap.map(row=>[row.code,row]));
  const seen=new Set<string>();
  const institutionCodes=new Set(catalog.institution.map(row=>row.code));
  for(const [i,line] of lines.entries()){
    if(!line.trim()||hasHeaders&&i===0)continue;
    const cells=line.split('\t').map(cell=>cell.trim());
    const code=(cells[hasHeaders?codeIndex:0] || '').toUpperCase();
    const name=cells[hasHeaders?nameIndex:1] || '';
    const unit=unitOf(cells[hasHeaders?unitIndex:2] || '');
    if(hasHeaders&&!code&&!name&&!cells[unitIndex])continue;
    if(hasHeaders&&header(code)===header(headers[codeIndex]))continue;
    const previous=rows.get(code);
    const packText=cells[hasHeaders?packIndex:3];
    const kgText=cells[hasHeaders?kgIndex:4];
    const linked=cells[hasHeaders?institutionIndex:5];
    const packFromName=unit==='Carton'
      ? digits(name).match(/(?:^|[^\d.,])(\d{1,3})\s*(?:كيس\s*)?[*×x]\s*\d+(?:[.,]\d+)?\s*(?:كغم|كغ|غم|جرام|kg|gm|g)(?![a-z])/i)
      : null;
    const pack=packText ? numeric(packText) : packFromName ? Number(packFromName[1]) : previous?.pack ?? null;
    const kg=kgText ? numeric(kgText) : previous?.kg ?? null;
    const target=linked ? digits(linked) : previous?.institutionCode || '';
    if(!sapCode.test(code)||!validName(name)||!unit||(packText&&pack===null)||(kgText&&kg===null)||
      !validNumber(pack,10000,true)||!validNumber(kg,10000)||(target&&!institutionCode.test(target))||seen.has(code))
      throw Error('راجع كود SAP والاسم والوحدة والشدّة في السطر '+(i+1)+'.');
    if(linked&&!institutionCodes.has(target))throw Error('رقم المؤسسة '+target+' في السطر '+(i+1)+' غير موجود في قائمة المؤسسة.');
    seen.add(code);
    rows.set(code,{code,name,unit,pack,kg,institutionCode:target,institutionAliases:previous?.institutionAliases});
  }
  if(!seen.size)throw Error('الصق بند SAP واحدًا على الأقل.');
  return {...catalog,sap:[...rows.values()]};
}

export function importAuditInstitution(input:string,catalog:AuditCatalog):AuditCatalog {
  const rows=new Map(catalog.institution.map(row=>[row.code,row]));
  const seen=new Set<string>();
  const lines=input.trim().split(/\r?\n/);
  const headers=lines[0].split('\t');
  const codeIndex=columns(headers,['رقمالمؤسسة','رقمالمادةبالمؤسسة','رقمالمادة','institutioncode','itemno']);
  const nameIndex=columns(headers,['اسمالمادة','تسميةالمؤسسة','اسمالصنف','اسمالمؤسسة','itemdescription']);
  const hasHeaders=codeIndex>=0;
  if(hasHeaders&&nameIndex<0)throw Error('أضف عمود تسمية المؤسسة إلى الجدول.');
  for(const [i,line] of lines.entries()){
    if(!line.trim()||hasHeaders&&i===0)continue;
    const cells=line.split('\t').map(cell=>cell.trim());
    const code=digits(cells[hasHeaders?codeIndex:0] || '');
    const name=cells[hasHeaders?nameIndex:1] || '';
    if(hasHeaders&&header(code)===header(headers[codeIndex]))continue;
    if(!institutionCode.test(code)||!validName(name)||seen.has(code))
      throw Error('راجع رقم مادة المؤسسة من 8 خانات والاسم في السطر '+(i+1)+'.');
    seen.add(code);
    rows.set(code,{code,name,price:rows.get(code)?.price ?? null});
  }
  if(!seen.size)throw Error('الصق بند مؤسسة واحدًا على الأقل.');
  return {...catalog,institution:[...rows.values()]};
}
