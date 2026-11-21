import type {Item} from './reconcile';

/** Add confirmed identity links for a new GENUINEL container without modifying
 * saved invoice prices, old SAP codes or unconfirmed carton pack factors.
 * Already assigned SAP codes are never reassigned automatically.
 */
const incoming=[
 {institution:'11062673',old:'CHS00620',incoming:'CHS00071',size:'350'},
 {institution:'11062674',old:'CHS00621',incoming:'CHS00072',size:'700'},
] as const;

export function withIncomingGenuinelAliases(items:Item[]):Item[]{
 const assigned=new Set(items.flatMap(item=>[
  item.sapCode,...(item.sapAliases||[]).map(alias=>alias.sapCode),
 ]).filter(Boolean).map(code=>code.toUpperCase()));
 let changed=false;
 const next=items.map(item=>{
  const match=incoming.find(candidate=>candidate.institution===item.code);
  if(!match||!item.active||item.sapCode!==match.old||
     !item.name.includes('قشقوان')||!item.name.includes(match.size)||
     assigned.has(match.incoming))return item;
  changed=true;
  return {...item,sapAliases:[...(item.sapAliases||[]),{
   sapCode:match.incoming,sapUnit:'Piece',cartonPieces:null,kgPerPiece:null,
  }]};
 });
 return changed?next:items;
}
