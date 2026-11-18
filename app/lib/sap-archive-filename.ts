/**
 * Supabase Storage rejects Unicode characters in object keys (HTTP 400
 * InvalidKey). Encode only unsupported filenames so established ASCII keys
 * and previous immutable archive locations remain untouched.
 *
 * This is a reversible *storage-key* encoding. The user's original filename
 * remains readable in the archive list and in download headers.
 */
const storageAsciiName=/^[A-Za-z0-9_.'!,*\&$@=;:+?() \-]+$/;
const encodedPrefix='saputf8-';

export function toSapStorageFilename(filename:string):string{
 if(storageAsciiName.test(filename)&&!filename.includes('__')&&!filename.startsWith(encodedPrefix)){
  return filename;
 }
 const bytes=new TextEncoder().encode(filename);
 const data=Array.from(bytes,byte=>String.fromCharCode(byte)).join('');
 // A dot substitutes for "/" so there are no path separators or "__"
 // delimiters in encoded filenames.
 return encodedPrefix+btoa(data).replace(/\+/g,'-').replace(/\//g,'.').replace(/=+$/,'');
}

export function fromSapStorageFilename(storageFilename:string):string{
 if(!storageFilename.startsWith(encodedPrefix))return storageFilename;
 const coded=storageFilename.slice(encodedPrefix.length);
 if(!/^[A-Za-z0-9.\-]+$/.test(coded))return storageFilename;
 try{
  const base64=coded.replace(/-/g,'+').replace(/\./g,'/');
  const binary=atob(base64.padEnd(Math.ceil(base64.length/4)*4,'='));
  const original=new TextDecoder('utf-8',{fatal:true}).decode(
   Uint8Array.from(binary,c=>c.charCodeAt(0)));
  return toSapStorageFilename(original)===storageFilename?original:storageFilename;
 }catch{return storageFilename;}
}
