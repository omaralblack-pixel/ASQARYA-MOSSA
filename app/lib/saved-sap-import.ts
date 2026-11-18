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
export function invalidateSavedSapRead(){sharedRead=undefined;}
export function readSavedSapImport():Promise<SavedSapImport|undefined>{
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
