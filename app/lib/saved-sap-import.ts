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

export async function readSavedSapImport(): Promise<SavedSapImport | undefined> {
  const response = await callSavedImport();
  return (await response.json()) ?? undefined;
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
