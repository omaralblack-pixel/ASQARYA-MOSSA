import {digits, fils, invoiceDocumentNo, pageNumber, parseTransfer, sapReferences, transferNumbers, type Draft} from './reconcile';

export type SerialInput = {row:number; number:string; amount:string; date:string};
export type SerialState = 'received'|'pending'|'missing'|'review';
export type SerialTransfer = {number:string; kind:'main'|'dry'|'adjustment'};
export type SerialRow = SerialInput & {state:SerialState; reason:string; transfers:SerialTransfer[]; branch:string};
export type SerialRecord = {id:string; branch:string; status?:string; payload:string};
export type SerialReport = {rows:SerialRow[]; blockers:string[]; count:{received:number;pending:number;missing:number;review:number}};

type Saved = {record:SerialRecord; draft:Draft; invoice:Draft['invoices'][number]; index:number};
function normalNumber(value:unknown) {
  return invoiceDocumentNo(value).replace(/[,٬]/g,'');
}
function serialTransfer(draft:Draft, saved:Saved, owner:Map<string,string>, blockers:string[]):SerialTransfer[] {
  const found:SerialTransfer[]=[];
  const references=new Map(sapReferences(draft.referenceSnapshot||[]).map(item=>[item.sapCode,item.code]));
  const multi=draft.invoices.length>1;
  for(const transfer of draft.transfers||[]){
    const numbers=transferNumbers(transfer.number||'');
    if(numbers.length!==1||!/^\d{4,20}$/.test(numbers[0])){
      blockers.push('فاتورة '+saved.invoice.number+': رقم ترحيل مركب أو غير صالح؛ لا يمكن تحديد اتجاه كل رقم بثقة.');
      continue;
    }
    const number=numbers[0];
    const previous=owner.get(number);
    if(previous&&previous!==saved.record.id)blockers.push('الترحيل '+number+' مكرر في سجلين مختلفين ('+previous+'، '+saved.record.id+').');
    else owner.set(number,saved.record.id);
    const p=parseTransfer(transfer.paste||'',{allowReverse:true});
    if(p.issues.length||p.excluded.length||!p.lines.length){
      blockers.push('الترحيل '+number+': بنود غير مقروءة أو خارج المسارات المعتمدة؛ لا يجوز تصنيفه دون مراجعة.');
      continue;
    }
    const routes=new Set(p.lines.map(line=>line.from+'>'+line.to));
    if(routes.size!==1) {
      blockers.push('الترحيل '+number+': يحتوي أكثر من اتجاه مستودعات؛ يجب فصل أو تصحيح المصدر.');
      continue;
    }
    const route=[...routes][0];
    const kind=route==='001>011'?'main':route==='002>011'?'dry':'adjustment';
    if(multi){
      const linked=new Set<number>();
      let ambiguous=false;
      for(const line of p.lines){
        const code=references.get(line.sapCode);
        const key=code&&draft.pages?.['i:'+code]?'i:'+code:'s:'+line.sapCode;
        const pg=pageNumber(draft.pages?.[key]);
        if(!pg||pg>draft.invoices.length){ambiguous=true;break;}
        linked.add(pg-1);
      }
      if(ambiguous||!linked.size){
        blockers.push('الترحيل '+number+': مجموعة متعددة الفواتير، ولا يمكن ربط جميع بنوده بصفحات فواتير محددة.');
        continue;
      }
      if(!linked.has(saved.index))continue;
    }
    if(found.some(row=>row.number===number)){
      blockers.push('الترحيل '+number+' مكرر داخل الفاتورة '+saved.invoice.number+'.');
      continue;
    }
    found.push({number,kind});
  }
  return found;
}
export function evaluateSerial(rows:SerialInput[], records:SerialRecord[]):SerialReport {
  const blockers:string[]=[];
  const index=new Map<string,Saved[]>();
  const transferOwner=new Map<string,string>();
  for(const record of records){
    let draft:Draft;
    try{draft=JSON.parse(record.payload) as Draft;}
    catch{blockers.push('سجل تالف تعذّر قراءته: '+record.id);continue;}
    if(!Array.isArray(draft.invoices)||!Array.isArray(draft.transfers)){
      blockers.push('سجل فواتير ناقص: '+record.id);continue;
    }
    for(const [i,invoice] of draft.invoices.entries()){
      const number=normalNumber(invoice.number);
      if(!number)continue;
      const saved={record,draft,invoice,index:i};
      index.set(number,[...(index.get(number)||[]),saved]);
    }
  }
  const inSheet=new Map<string,number>();
  const result:SerialRow[]=rows.map(row=>{
    const number=normalNumber(row.number);
    const key=number;
    const base={...row,number,state:'missing' as SerialState,reason:'غير موجودة في السجل',transfers:[] as SerialTransfer[],branch:''};
    if(!/^\d{8,20}$/.test(number)){
      blockers.push('صف '+row.row+': رقم فاتورة مفقود أو غير صالح.');
      return {...base,state:'review',reason:'رقم فاتورة غير صالح'};
    }
    if(inSheet.has(key)){
      blockers.push('رقم الفاتورة '+number+' مكرر في صفّي '+inSheet.get(key)+' و'+row.row+' من Excel سجى.');
      return {...base,state:'review',reason:'رقم فاتورة مكرر في Excel'};
    }
    inSheet.set(key,row.row);
    const candidates=index.get(number)||[];
    if(candidates.length>1){
      blockers.push('رقم الفاتورة '+number+' مكرر في سجلات المشروع ('+candidates.length+' مرات).');
      return {...base,state:'review',reason:'رقم الفاتورة مكرر في سجلات المشروع'};
    }
    if(!candidates.length)return base;
    const saved=candidates[0], amount=fils(row.amount);
    const confirmed=fils(saved.invoice.amount||'');
    const transfers=serialTransfer(saved.draft,saved,transferOwner,blockers);
    if(!transfers.length)blockers.push('فاتورة '+number+': لم يتم التحقق من أي ترحيل مرتبط بها.');
    const payloadSummary=(saved.draft as Draft & {summary?:{status?:string}}).summary;
    const rowBase={...base,transfers,branch:saved.record.branch||''};
    if(amount===null||confirmed===null){
      blockers.push('فاتورة '+number+': مبلغ غير صالح أو مفقود في ملف سجى أو سجل المشروع.');
      return {...rowBase,state:'review',reason:'المبلغ غير صالح أو مفقود'};
    }
    if(amount!==confirmed)return {...rowBase,state:'review',reason:'فرق مبلغ: سجى '+row.amount+' / السجل '+saved.invoice.amount};
    if(saved.invoice.complete!==true)return {...rowBase,state:'pending',reason:'الفاتورة محفوظة لكن الورق غير مؤكد'};
    if(payloadSummary?.status&&payloadSummary.status!=='match')return {...rowBase,state:'review',reason:'المطابقة المحفوظة غير معتمدة: '+payloadSummary.status};
    return {...rowBase,state:'received',reason:'رقم الفاتورة والمبلغ مؤكدان'};
  });
  const count={received:0,pending:0,missing:0,review:0};
  for(const row of result)count[row.state]++;
  return {rows:result,blockers:[...new Set(blockers)],count};
}
export function serialColumns(transfers:SerialTransfer[]):string[] {
  const seen=new Set<string>();
  const uniq=transfers.filter(t=>{if(seen.has(t.number))return false;seen.add(t.number);return true;});
  const main=uniq.filter(t=>t.kind==='main'),dry=uniq.filter(t=>t.kind==='dry');
  const others=uniq.filter(t=>t.kind==='adjustment');
  return [main.shift()?.number||'',dry.shift()?.number||'',...main.map(t=>t.number),...dry.map(t=>t.number),...others.map(t=>t.number)];
}
