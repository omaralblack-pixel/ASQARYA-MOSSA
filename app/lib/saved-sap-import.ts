import {boundedRead} from './bounded-read';
export type SavedSapImport = { name: string; text: string };
export const maxSapFileBytes = 16 * 1024 * 1024;

async function callSavedImport(init?: RequestInit) {
  const response = await fetch("/api/sap-import", { ...init, cache: "no-store" });
  if (response.status === 401) window.location.assign("/login");
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw Error(detail?.error || "تعذّر الوصول إلى كشف SAP المحفوظ.");
  }
  return response;
}

let sharedRead:Promise<SavedSapImport|undefined>|undefined;
export function readSavedSapImport(options:{signal?:AbortSignal}={}):Promise<SavedSapImport|undefined>{
  if(options.signal)return boundedRead('/api/sap-import',async response=>{
    if(!response.ok)throw Error('تعذّر قراءة كشف SAP المحفوظ (HTTP '+response.status+').');
    try{return (await response.json())??undefined}
    catch{throw Error('كشف SAP المحفوظ غير مكتمل أو غير صالح. أعد المحاولة.')}
  },{signal:options.signal,timeoutMs:45_000});
  if(sharedRead)return sharedRead;
  sharedRead=callSavedImport().then(async response=>(await response.json()) as SavedSapImport|null).then(value=>value??undefined).finally(()=>{sharedRead=undefined});
  return sharedRead;
}

export async function saveSapImport(file: SavedSapImport) {
  if (new Blob([file.text]).size > maxSapFileBytes) throw Error("حجم كشف SAP يتجاوز 16 ميغابايت.");
  await callSavedImport({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });
}

export async function deleteSavedSapImport() {
  await callSavedImport({ method: "DELETE" });
}
