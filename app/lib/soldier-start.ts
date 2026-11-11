/** The page-sorting soldier begins with groups CREATED from 11 Nov 2026 in Amman.
 * This is not an invoice or SAP posting date: entering old paperwork today
 * still counts as a new group and must be checked.
 */
export const SOLDIER_START_DATE='2026-11-11';
const SOLDIER_START_UTC=Date.parse('2026-11-10T21:00:00.000Z'); // Amman: midnight, UTC+03:00

export function isHistoricalSoldierRecord(created:unknown):boolean {
  if(typeof created!=='string'||!created.trim())return false;
  const timestamp=Date.parse(created);
  return Number.isFinite(timestamp)&&timestamp<SOLDIER_START_UTC;
}
