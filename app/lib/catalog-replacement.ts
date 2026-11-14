import {digits, numeric, sapReferences, type Item} from './reconcile';

export type ReplacementInput = {
  line: number;
  institutionCode: string;
  institutionName: string;
  sapCode: string;
  sapName: string;
  cartonPieces: number | null;
  sapUnit: 'Piece' | 'Carton' | 'KG' | null;
  kgPerPiece: number | null;
  errors: string[];
};
export type ReplacementPreview = ReplacementInput & {
  targetCode: string;
  current: Item | null;
  proposed: Item | null;
  change: boolean;
  status: 'ready' | 'unchanged' | 'error';
  reason: string;
};

const normalized = (s:string) => s.toLowerCase().trim().replace(/[أإآٱ]/g,'ا')
  // Arabic headings may contain shadda, vowels or tatweel (e.g. "شدّة الكرتونة").
  .replace(/[\u064B-\u065F\u0670\u0640]/g,'')
  .replace(/[\s._:\-\/()\[\]]/g,'');
const candidate = (headers:string[], names:string[]) =>
  headers.findIndex(h => names.includes(h));
const packFields = ['cartonpieces','piecespercarton','piecesincarton','packsize','cartonpack','unitspercarton','شدةالكرتونة','شدالكرتونة','عددالحبات','حباتالكرتونة','حبةبالكرتونة','الحباتبالكرتونة'];
const instCodeFields = ['institutioncode','institutionitemno','institutionitemnumber','institutionno','رقمالمادةبالمؤسسة','رقمالمادةالمؤسسة','رقمالمادة','كودالمؤسسة','رقمالصنفبالمؤسسة'];
const instNameFields = ['institutionname','institutionitemname','اسمالمادةبالمؤسسة','اسمالصنفبالمؤسسة','اسمالمادةالمؤسسة','اسمالصنفالمؤسسة'];
const sapCodeFields = ['sapcode','sapitemno','sapitemcode','itemno','itemcode','كودsap','كودساب','رقمsap','رقمكودsap','كودالصنف'];
const sapNameFields = ['sapname','sapdescription','itemdescription','description','اسمsap','اسمساب','اسمالصنفبساب','وصفsap','وصفالصنف'];
const unitFields = ['sapunit','uomname','uomcode','uom','inventoryuom','وحدةsap','وحدةساب','الوحدة'];
const weightFields = ['kgperpiece','pieceweightkg','وزنالحبة','وزنالحبةكغم'];
function unit(v:string):'Piece'|'Carton'|'KG'|null {
  const value=normalized(v);
  if (!value) return null;
  if (['piece','pcs','pc','حبة','حبه','قطعة','قطعه'].includes(value))return 'Piece';
  if (['carton','ctn','كرتونة','كرتونه','كرتون'].includes(value))return 'Carton';
  if (['kg','kilogram','كيلو','كغم','كيلوغرام'].includes(value))return 'KG';
  return null;
}
function positive(v:string, integer=false):number|null {
  if (!v.trim())return null;
  const n=numeric(v);
  return n!==null && n>0 && n<=100000 && (!integer || Number.isInteger(n)) ? n : null;
}
export function parseReplacementText(text:string):{rows:ReplacementInput[]; errors:string[]} {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(row=>row.trim());
  if (!lines.length)return {rows:[],errors:[]};
  const headers=lines[0].split('\t').map(normalized);
  const col={
    institutionCode:candidate(headers,instCodeFields),
    institutionName:candidate(headers,instNameFields),
    sapCode:candidate(headers,sapCodeFields),
    sapName:candidate(headers,sapNameFields),
    cartonPieces:candidate(headers,packFields),
    sapUnit:candidate(headers,unitFields),
    kgPerPiece:candidate(headers,weightFields),
  };
  if (col.sapCode<0)return {rows:[],errors:['الصق جدولًا مع عناوين الأعمدة، ولازم يحتوي كود SAP أو Item No. يمكن إضافة رقم المادة بالمؤسسة لربط صنف مختلف.']};
  const rows:ReplacementInput[]=[];
  for(let i=1;i<lines.length;i++){
    const cells=lines[i].split('\t');
    if(cells.map(normalized).join('|')===headers.join('|'))continue;
    const get=(index:number)=>index<0?'':(cells[index]||'').trim();
    const sapCode=get(col.sapCode).toUpperCase();
    const institutionCode=digits(get(col.institutionCode)).trim();
    const institutionName=get(col.institutionName);
    const sapName=get(col.sapName);
    const cartonRaw=get(col.cartonPieces), kgRaw=get(col.kgPerPiece);
    const unitRaw=get(col.sapUnit);
    const cartonPieces=positive(cartonRaw,true);
    const kgPerPiece=positive(kgRaw);
    const sapUnit=unit(unitRaw);
    const errors:string[]=[];
    if(!/^[A-Z]{2,6}\d{3,10}$/.test(sapCode))errors.push('كود SAP غير صالح');
    if(institutionCode&&!/^\d{8}$/.test(institutionCode))errors.push('رقم المؤسسة يجب أن يتكون من 8 أرقام');
    if(cartonRaw&&!cartonPieces)errors.push('شدّة الكرتونة غير صالحة');
    if(kgRaw&&!kgPerPiece)errors.push('وزن الحبة غير صالح');
    if(unitRaw&&!sapUnit)errors.push('وحدة SAP غير معروفة');
    rows.push({line:i+1,institutionCode,institutionName,sapCode,sapName,cartonPieces,sapUnit,kgPerPiece,errors});
  }
  return {rows,errors:[]};
}

/** Institution number and institution name never change during a SAP import. */
export function previewReplacements(inputs:ReplacementInput[],reference:Item[]):ReplacementPreview[] {
  const byCode=new Map(reference.map(item=>[item.code,item]));
  const bySap=new Map(sapReferences(reference).map(item=>[item.sapCode.toUpperCase(),item]));
  const proposed=inputs.map(input=>{
    const errors=[...input.errors];
    const matched=input.institutionCode?byCode.get(input.institutionCode):bySap.get(input.sapCode);
    // sapReferences projects aliases as primary-looking items. Always update
    // the original institution item so its real primary SAP code is retained.
    const owner=matched?byCode.get(matched.code):undefined;
    if(!owner)errors.push(input.institutionCode?'رقم المادة بالمؤسسة غير موجود في المرجع؛ عرّفه أولًا.':'كود SAP غير مربوط برقم مادة بالمؤسسة. لا يتم الربط بالاسم.');
    if(owner && !owner.active)errors.push('الصنف غير مفعّل في مرجع المؤسسة.');
    if(owner && input.institutionCode && input.sapCode!==owner.sapCode &&
        !owner.sapAliases?.some(alias=>alias.sapCode===input.sapCode)) {
      // Replacing a code is supported only by explicit institution number.
      const occupied=bySap.get(input.sapCode);
      if(occupied && occupied.code!==owner.code)errors.push('كود SAP الجديد مربوط برقم مادة آخر.');
    }
    const changeAlias=Boolean(owner?.sapAliases?.some(alias=>alias.sapCode===input.sapCode));
    const next:Item|null=owner?changeAlias?{
      ...owner,
      sapAliases:owner.sapAliases?.map(alias=>alias.sapCode!==input.sapCode?alias:{
        ...alias,
        cartonPieces:input.cartonPieces??alias.cartonPieces,
        sapUnit:input.sapUnit??alias.sapUnit,
        kgPerPiece:input.kgPerPiece??alias.kgPerPiece,
      })
    }:{
      ...owner, sapCode:input.sapCode,
      warehouseName:input.sapName||owner.warehouseName,
      warehouseUnit:input.sapUnit??owner.warehouseUnit,
      sapUnit:input.sapUnit??owner.sapUnit,
      cartonPieces:input.cartonPieces??owner.cartonPieces,
      kgPerPiece:input.kgPerPiece??owner.kgPerPiece,
    }:null;
    const definition=changeAlias?next?.sapAliases?.find(alias=>alias.sapCode===input.sapCode):next;
    if(definition?.sapUnit==='Carton' && (!definition.cartonPieces || definition.cartonPieces<=0))errors.push('يجب إدخال عدد حبات الكرتونة قبل تحويل كرتون إلى حبات.');
    if(definition?.sapUnit==='KG' && (!definition.kgPerPiece || definition.kgPerPiece<=0))errors.push('يجب إدخال وزن الحبة قبل تحويل KG.');
    const change=!!(next&&owner&&JSON.stringify(owner)!==JSON.stringify(next));
    return {...input,targetCode:owner?.code||'',current:owner||null,proposed:next,change,
      status:errors.length?'error':change?'ready':'unchanged',
      reason:errors.join('؛ ')||(change?'جاهز للتحديث':'لا يوجد تغيير') } as ReplacementPreview;
  });
  const counts=new Map<string,number>();
  for(const row of proposed)if(row.targetCode&&row.change){
    counts.set(row.targetCode,(counts.get(row.targetCode)||0)+1);
  }
  return proposed.map(row=>counts.get(row.targetCode)!>1 && row.change?
    {...row,status:'error' as const,reason:'عدة أسطر تستبدل نفس صنف المؤسسة. افصلها حتى لا تضيع شدّة أو كود.'}:row);
}
export function applyReplacements(reference:Item[],preview:ReplacementPreview[], selectedLines:number[]):Item[]{
  const selected=new Set(selectedLines);
  const chosen=preview.filter(row=>selected.has(row.line));
  if(!chosen.length)throw Error('حدد صنفًا واحدًا على الأقل للحفظ.');
  if(chosen.some(row=>row.status!=='ready'||!row.proposed))throw Error('هناك صنف يحتاج مراجعة قبل الحفظ.');
  const updates=new Map(chosen.map(row=>[row.targetCode,row.proposed!]));
  if(updates.size!==chosen.length)throw Error('نفس رقم المؤسسة موجود في أكثر من تعديل.');
  const next=reference.map(item=>updates.get(item.code)||item);
  const codes=new Set<string>();
  for(const item of sapReferences(next)){
    if(codes.has(item.sapCode))throw Error('كود SAP مكرر بين أصناف المؤسسة: '+item.sapCode);
    codes.add(item.sapCode);
  }
  return next;
}
