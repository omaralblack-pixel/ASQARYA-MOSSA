import type {Item} from './reconcile';
/** Non-destructive reference-quality audit: never overwrite prices or SAP factors. */
export function auditInstitutionReference(items:readonly Item[]){
  const missingPrices=items.filter(row=>row.active&&row.price===null);
  const packDifferences=items.filter(row=>row.active&&row.invoicePack!==null&&row.cartonPieces!==null&&
    row.invoicePack!==row.cartonPieces);
  return {missingPrices,packDifferences};
}
