import {parseTransfer,transferNumbers,type Draft} from './reconcile';
import type {SapImportGroup} from './sap-import';

export function isLinkableReverse(group:SapImportGroup):boolean{
 return group.members.length>0&&group.members.every(member=>{
  const parsed=parseTransfer(member.transfer.paste,{allowReverse:true});
  return !member.issues.length&&parsed.lines.length>0&&!parsed.issues.length&&!parsed.excluded.length&&parsed.lines.every(line=>line.from==='011');
 });
}

export function mergeSelectedTransfers(target:SapImportGroup,reversals:SapImportGroup[]):Draft{
 if(target.reversal||target.issues.length||!target.draft.branch||!reversals.length)throw Error('حدد مجموعة فواتير سليمة وترحيلًا عكسيًا واحدًا على الأقل.');
 const transfers=[...target.draft.transfers],numbers=new Set(transfers.flatMap(transfer=>transferNumbers(transfer.number)));
 for(const group of reversals){
  if(!isLinkableReverse(group))throw Error('أحد الترحيلات ليس عكسيًا صالحًا أو يحتاج مراجعة.');
  for(const member of group.members){
   if(member.branch&&member.branch!==target.draft.branch)throw Error('الترحيل '+member.transfer.number+' تابع لفرع آخر.');
   for(const number of transferNumbers(member.transfer.number)){
    if(numbers.has(number))throw Error('الترحيل '+number+' مكرر في المجموعة.');
    numbers.add(number);
   }
   transfers.push(member.transfer);
  }
 }
 if(transfers.length>30)throw Error('عدد الترحيلات يتجاوز الحد المسموح للمجموعة.');
 return {...target.draft,transfers};
}
