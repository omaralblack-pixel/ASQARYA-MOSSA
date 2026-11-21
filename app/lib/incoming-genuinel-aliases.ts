import type {Item} from './reconcile';

/** New GENUINEL SAP SKUs refer to existing institution items.
 * Carton quantities were explicitly confirmed by the operator:
 * 350g CHS00071 = 45 pieces; historical CHS00620 = 32 pieces.
 * 700g CHS00072 = 20 pieces; historical CHS00621 = 20 pieces.
 * Historical source lines and saved invoice pricing remain unchanged.
 * Never attach a code owned by another institution item.
 */
const incoming=[
 {institution:'11062673',old:'CHS00620',incoming:'CHS00071',size:'350',pack:45},
 {institution:'11062674',old:'CHS00621',incoming:'CHS00072',size:'700',pack:20},
] as const;

export function withIncomingGenuinelAliases(items:Item[]):Item[]{
 const owners=new Map<string,string>();
 for(const item of items){
  for(const code of [item.sapCode,...(item.sapAliases||[]).map(alias=>alias.sapCode)]){
   if(code)owners.set(code.toUpperCase(),item.code);
  }
 }
 let changed=false;
 const next=items.map(item=>{
  const match=incoming.find(candidate=>candidate.institution===item.code);
  if(!match||!item.active||item.sapCode!==match.old||
     !item.name.includes('قشقوان')||!item.name.includes(match.size)||
     (owners.has(match.incoming)&&owners.get(match.incoming)!==item.code))return item;
  const aliases=item.sapAliases||[];
  const existing=aliases.find(alias=>alias.sapCode===match.incoming);
  if(existing){
   // Normalize a prior unknown/outdated factor without duplicating the link.
   if(existing.sapUnit==='Piece'&&existing.cartonPieces===match.pack)return item;
   changed=true;
   return {...item,sapAliases:aliases.map(alias=>alias!==existing?alias:{
    ...alias,sapUnit:'Piece',cartonPieces:match.pack,
   })};
  }
  changed=true;
  return {...item,sapAliases:[...aliases,{
   sapCode:match.incoming,sapUnit:'Piece',cartonPieces:match.pack,kgPerPiece:null,
  }]};
 });
 return changed?next:items;
}
