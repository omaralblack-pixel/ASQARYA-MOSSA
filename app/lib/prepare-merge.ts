import {documentNo,parseTransfer,transferNumbers,type Draft,type Transfer} from './reconcile';
export function prepareGroupMerge(primary:Draft,other:Draft,reverse:Transfer,invoiceNumber:string):Draft{
 if(!primary.id||!other.id||primary.id===other.id||primary.version==null||other.version==null)throw Error('يلزم اختيار سجلين محفوظين مختلفين.');
 if(primary.branch!==other.branch)throw Error('السجلان لفرعين مختلفين.');
 if(primary.invoices.length!==1||other.invoices.length!==1)throw Error('الدمج الآلي يتطلب فاتورة واحدة بكل مجموعة.');
 const a=primary.invoices[0],b=other.invoices[0],number=documentNo(invoiceNumber);
 if(!/^\d{10}$/.test(number))throw Error('رقم الفاتورة الزرقاء غير صالح.');
 if([a.number,b.number].some(x=>x&&documentNo(x)!==number))throw Error('رقم الفاتورة مختلف بين السجلين.');
 if(a.amount&&b.amount&&a.amount!==b.amount)throw Error('مبلغ الفاتورة مختلف بين السجلين.');
 if(a.date&&b.date&&a.date!==b.date)throw Error('تاريخ الفاتورة مختلف بين السجلين.');
 if(JSON.stringify(primary.referenceSnapshot)!==JSON.stringify(other.referenceSnapshot))throw Error('مرجع السجلين مختلف؛ يلزم مراجعة الأسعار والشدات.');
 if(primary.driver&&other.driver&&primary.driver!==other.driver)throw Error('اسم السائق مختلف بين السجلين.');
 if(Object.keys(a.quantities||{}).length||Object.keys(b.quantities||{}).length)throw Error('توجد كميات فاتورة مدخلة يدويًا؛ يلزم مراجعتها.');
 if((a.attachments||[]).length||(b.attachments||[]).length)throw Error('توجد مرفقات تحتاج مراجعة قبل الدمج.');
 const mergeMap=(x:Record<string,string>|undefined,y:Record<string,string>|undefined)=>{const z={...x};for(const [key,value] of Object.entries(y||{})){if(z[key]!==undefined&&z[key]!==value)throw Error('توزيع الصفحات أو الاستبعادات مختلف ويحتاج مراجعة.');z[key]=value}return z};
 const checks={...primary.checks};for(const [key,value] of Object.entries(other.checks||{})){if(checks[key]&&JSON.stringify(checks[key])!==JSON.stringify(value))throw Error('تشييك الصنف مختلف ويحتاج مراجعة.');checks[key]=value}
 const parsed=parseTransfer(reverse.paste,{allowReverse:true});
 if(!parsed.lines.length||parsed.issues.length||parsed.excluded.length||parsed.lines.some(line=>line.from!=='011'))throw Error('الترحيل العكسي غير صالح.');
 const transfers=[...primary.transfers,...other.transfers,reverse],numbers=transfers.flatMap(t=>transferNumbers(t.number));
 if(numbers.length!==new Set(numbers).size)throw Error('رقم ترحيل مكرر.');
 if(transfers.length>30)throw Error('عدد الترحيلات يتجاوز الحد.');
 const invoice={...a,number,amount:a.amount||b.amount,date:a.date||b.date,complete:a.complete||b.complete,manualNumber:true};
 return {...primary,driver:primary.driver||other.driver,invoices:[invoice],transfers,checks,pages:mergeMap(primary.pages,other.pages),excludedItems:mergeMap(primary.excludedItems,other.excludedItems),notes:[primary.notes,other.notes].filter(Boolean).join('\n'),acceptedDifference:undefined};
}
