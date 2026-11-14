import type {BlueLine} from './aqaba';

/** Verbatim quantities/prices from aqaba_prices_reconciliation_2026-11-03.xlsx.
 * Prices stored in integer fils in the CSV below (not floating point).
 * Pack sizes are workbook-estimated conversions; NOT certified SAP UoM.
 * Keep these separate from Amman institution pricing and SAP AR Invoice prices.
 */
export const AQABA_BLUE_SEED_DATE='2026-11-03';
export const AQABA_BLUE_SEED_SOURCE='aqaba_prices_reconciliation_2026-11-03.xlsx';
export const AQABA_BLUE_SEED_TRANSFER='2615754';
const csv="2650710367,CFC00195,60,1200,12\n2650710367,CFC00006,24,750,24\n2650710367,CFC00007,24,1050,24\n2650710367,CHS00620,25,2550,1\n2650710367,CHS00621,20,4990,1\n2650710367,CHS00491,24,1140,1\n2650710367,CHS00469,24,1390,1\n2650710367,CHS00470,10,3350,1\n2650710367,CHS00471,10,5900,1\n2650710367,CHS00022,12,1770,1\n2650710367,CHS00014,12,2490,1\n2650710367,CHS00012,12,2490,1\n2650710367,CHS00009,12,2490,1\n2650710367,CHS00004,12,2490,1\n2650710367,CHS00005,36,1650,1\n2650710367,CHS00007,12,1650,1\n2650710368,DAR00005,100,1290,1\n2650710368,DAR00027,120,560,1\n2650710368,FVL00035,140,1250,20\n2650710368,FVL00036,160,990,20\n2650710368,FVL00037,100,590,20\n2650710368,FVL00111,40,750,20\n2650710368,FVL00034,100,590,20\n2650710368,CHS00544,6,1650,1\n2650710368,CHS00545,6,1650,1\n2650710368,FVL00332,100,300,20\n2650710368,FVL00042,50,1550,10\n2650710368,FVL00043,200,3690,4\n2650710368,FVL00302,300,300,20\n2650710368,FVL00276,140,880,20\n2650710368,FVL00322,140,890,20\n2650710368,FVL00316,140,550,20\n2650710368,FVL00303,200,300,20\n2650710368,DAR00004,300,2400,1\n2650710369,FVL00306,100,450,20\n2650710369,FVL00311,40,1440,8\n2650710369,FVL00014,60,750,20\n2650710369,FVL00012,60,750,20\n2650710369,CHS00561,600,350,1\n2650710369,CHS00563,84,1350,1\n2650710369,FOD00064,80,750,40\n2650710369,CHS00033,12,1990,1\n2650710369,CHS00055,21,2200,1\n2650710369,CHS00042,12,1990,1\n2650710369,CHS00516,6,1800,1\n2650710369,CHS00518,6,1800,1\n2650710369,CHS00546,6,1650,1\n2650710369,CHS00550,6,1650,1\n2650710369,FVL00307,40,400,20\n2650710369,FVL00109,60,500,20\n2650710369,CFC00083,24,1050,24\n2650710369,FVL00376,60,690,1";
export type AqabaBlueSeed={invoice:string;code:string;quantity:number;priceFils:number;estimatedPack:number};
export function aqabaBlueSeed():AqabaBlueSeed[]{
 return csv.split('\n').map(row=>{
  const [invoice,code,qty,priceFils,estimatedPack]=row.split(',');
  return {invoice,code,quantity:Number(qty),priceFils:Number(priceFils),estimatedPack:Number(estimatedPack)};
 });
}
export function aqabaSeedInvoiceLines(reference:ReadonlyArray<{sapCode?:string;warehouseName?:string;name?:string}>):BlueLine[]{
 const names=new Map(reference.filter(r=>r.sapCode).map(r=>[r.sapCode!,r.warehouseName||r.name||'']));
 return aqabaBlueSeed().map(r=>({
  key:r.invoice+'|'+r.code+'|1',invoice:r.invoice,date:AQABA_BLUE_SEED_DATE,
  item:r.code,description:names.get(r.code)||r.code,
  quantity:r.quantity,unit:'Piece',price:r.priceFils/1000,
  officialNumbers:[],transferNumbers:[AQABA_BLUE_SEED_TRANSFER],
  sourceFile:AQABA_BLUE_SEED_SOURCE,sourceEstimatedPack:r.estimatedPack,
 }));
}
export function aqabaSeedTotals(){
 const amounts=new Map<string,number>();
 for(const r of aqabaBlueSeed())amounts.set(r.invoice,(amounts.get(r.invoice)||0)+r.quantity*r.priceFils);
 return amounts;
}
