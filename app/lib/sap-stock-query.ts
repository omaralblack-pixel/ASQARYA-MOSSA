/** Closing stock in inventory UoM, using the complete SAP inventory journal. */
export function sapStockBalanceQuery(date:string):string{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'0001-01-01')return '';
  const timestamp=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==date)return '';
  // DocDate is a DATE in SAP B1: <= includes every posting on the selected day.
  // No lower date bound, document-type filter or HAVING: keep historical and zero stock.
  return `-- SAP Business One HANA - Warehouse 011
-- Closing stock through ${date} (posting date, inclusive)
SELECT
    M."ItemCode" AS "رقم الصنف",
    I."ItemName" AS "اسم الصنف",
    M."Warehouse" AS "المستودع",
    I."InvntryUom" AS "وحدة المخزون",
    SUM(M."InQty" - M."OutQty") AS "الرصيد الفعلي بنهاية التاريخ"
FROM "OINM" M
LEFT JOIN "OITM" I ON I."ItemCode" = M."ItemCode"
WHERE M."Warehouse" = '011'
  AND M."DocDate" <= TO_DATE('${date}', 'YYYY-MM-DD')
GROUP BY M."ItemCode", I."ItemName", M."Warehouse", I."InvntryUom"
ORDER BY M."ItemCode";`;
}
