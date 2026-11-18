import type {Item,TransferLine} from './reconcile';

/**
 * Diagnostic only. Never round a saved SAP transfer, approve an invoice, or
 * change the amount used by reconciliation. A "suspected" rounding variance
 * only means a fractional-carton SAP line may have been truncated/rounded
 * in its reported UoM, within one last reported decimal increment.
 */
export type FractionalQuantityInput={
 key:string;code:string;sapCode:string;name:string;
 transfer:number|null;unitPrice:number|null;item:Item|null;
 details:TransferLine[];errors:string[];
};

export type FractionalQuantityNote={
 key:string;code:string;sapCode:string;name:string;transferNos:string[];
 sapQuantity:number;nearestWholePiece:number;pieceDifference:number;
 amountDifferenceFils:number|null;suspectedSapRounding:boolean;
};

export function fractionalQuantityNotes(rows:readonly FractionalQuantityInput[]):FractionalQuantityNote[]{
 return rows.flatMap(row=>{
  if(row.transfer===null||!Number.isFinite(row.transfer)||row.errors.length)return [];
  const nearestWholePiece=Math.round(row.transfer);
  const pieceDifference=Number((row.transfer-nearestWholePiece).toFixed(6));
  if(Math.abs(pieceDifference)<0.000001)return [];
  const fractionalCartons=row.details.filter(line=>line.unit==='Carton'&&
   Math.abs(line.quantity-Math.round(line.quantity))>0.000000001);
  const cartonPieces=row.item?.cartonPieces??0;
  // SAP sometimes displays 0.041 Carton instead of 1/24 Carton. Permit
  // only a small variance explainable by the displayed carton precision.
  // A genuine 0.5-carton/1.5-piece transfer is NOT a rounding match.
  const maxSapStep=fractionalCartons.reduce((sum,line)=>{
   const decimalPlaces=(Math.abs(line.quantity).toString().split('.')[1]||'').length;
   return sum+cartonPieces*Math.pow(10,-Math.max(decimalPlaces,1));
  },0);
  const suspectedSapRounding=cartonPieces>0&&fractionalCartons.length>0&&
   row.details.every(line=>line.unit==='Carton'||line.unit==='Piece'&&Number.isInteger(line.quantity))&&
   Math.abs(pieceDifference)<=Math.min(0.25,maxSapStep+0.000001);
  const amountDifferenceFils=row.unitPrice===null||!Number.isFinite(row.unitPrice)
   ?null:Math.round(row.transfer*row.unitPrice)-Math.round(nearestWholePiece*row.unitPrice);
  return [{
   key:row.key,code:row.code,sapCode:row.sapCode,name:row.name,
   transferNos:[...new Set((fractionalCartons.length?fractionalCartons:row.details)
    .map(line=>line.transferNo||'').filter(Boolean))],
   sapQuantity:row.transfer,nearestWholePiece,pieceDifference,
   amountDifferenceFils,suspectedSapRounding
  }];
 });
}
