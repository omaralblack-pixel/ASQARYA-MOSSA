export type SavedSapImport={name:string;text:string};
export const maxSapFileBytes=16*1024*1024;

function openDatabase():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('asqarya-sap-import',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('files');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

async function useStore<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await openDatabase();
  try{
    return await new Promise((resolve,reject)=>{
      const transaction=db.transaction('files',mode);
      const request=operation(transaction.objectStore('files'));
      transaction.oncomplete=()=>resolve(request.result);
      transaction.onabort=()=>reject(transaction.error??request.error);
    });
  }finally{
    db.close();
  }
}

export function readSavedSapImport():Promise<SavedSapImport|undefined>{
  return useStore('readonly',store=>store.get('current'));
}

export async function saveSapImport(file:SavedSapImport){
  if(new Blob([file.text]).size>maxSapFileBytes)throw Error('حجم كشف SAP يتجاوز 16 ميغابايت.');
  await useStore('readwrite',store=>store.put(file,'current'));
}

export async function deleteSavedSapImport(){
  await useStore('readwrite',store=>store.delete('current'));
}
