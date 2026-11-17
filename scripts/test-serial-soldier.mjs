import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const rec=url(compile(fs.readFileSync('app/lib/reconcile.ts','utf8')));
const collector=url(compile(fs.readFileSync('app/lib/invoice-collector.ts','utf8').replace("'./reconcile'","'"+rec+"'")));
const source=fs.readFileSync('app/lib/serial-soldier.ts','utf8').replace("'./reconcile'","'"+rec+"'")
 .replace("'./invoice-collector'","'"+collector+"'");
const {evaluateSerial,serialColumns,serialReviewNote,serialInvoiceColumns,projectSerialTransferCells,duplicateGeneratedSerialRows,serialMergeProposals,previouslyApprovedSerialMerges,auditSerialExport,serialWorkingDays}=await import(url(compile(source)));
const header='Item No.\tItem Description\tQuantity\tUoM Code\tFrom Warehouse\tTo Warehouse';
const paste=(code,from,to)=>header+'\n'+code+'\tItem\t1\tPiece\t'+from+'\t'+to;
const invoice=(number,amount,complete=true)=>({number,amount,complete});
const transfer=(number,code,from,to)=>({number,paste:paste(code,from,to)});
const record=(id,invoices,transfers,extra={})=>({id,branch:'فرع تجريبي',payload:JSON.stringify({invoices,transfers,summary:{status:'match'},...extra})});
const row=(row,number,amount)=>({row,number,amount,date:'2026-11-09'});
const base=[
 transfer('2611001','DAR00001','001','011'),
 transfer('2611002','DAR00002','002','011'),
 transfer('2611003','DAR00003','009','011'),
 transfer('2611004','DAR00004','011','001'),
];
const correct=record('g1',[invoice('2624002303','186.400')],base);
let result=evaluateSerial([row(5,'2624002303','186.4')],[correct]);
assert.deepEqual(result.count,{received:1,pending:0,missing:0,review:0});
assert.deepEqual(result.blockers,[]);
assert.deepEqual(serialColumns(result.rows[0].transfers),['2611001','2611002','2611003','2611004']);
result=evaluateSerial([row(5,'2624002303','186.401')],[correct]);
assert.equal(result.rows[0].state,'received_difference','One-fils discrepancy is received but stays yellow');
assert.equal(result.count.received,1,'A received invoice with a difference belongs in received total');
assert.equal(result.count.review,0,'Amount difference alone must not count as unreceived/review');
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400',false)],base)]);
assert.equal(result.rows[0].state,'pending','Unchecked paper must stay pink');
result=evaluateSerial([row(5,'2624002303','186.401')],[record('g1',[invoice('2624002303','186.400',false)],base)]);
assert.equal(result.rows[0].state,'pending','Amount difference must never conceal unconfirmed paper');
assert.ok(serialReviewNote(result.rows[0]).includes('ورق الفاتورة غير مؤكد'));
result=evaluateSerial([row(5,'9999999999','1.000')],[correct]);
assert.equal(result.rows[0].state,'missing');
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400')],base,{summary:{status:'review'}})]);
assert.equal(result.rows[0].state,'review','Unapproved reconciliation cannot be received');
result=evaluateSerial([row(5,'2624002303','186.401')],[record('g1',[invoice('2624002303','186.400')],base,{summary:{status:'review'}})]);
assert.equal(result.rows[0].state,'review','Discrepancy does not override an unapproved reconciliation');
assert.ok(serialReviewNote(result.rows[0]).includes('المطابقة المحفوظة غير معتمدة'));
result=evaluateSerial([row(5,'2624002303','186.400'),row(7,'2624002303','186.400')],[correct]);
assert.ok(result.blockers.some(e=>e.includes('مكرر')));
result=evaluateSerial([row(5,'2624002303','186.400')],[correct,record('g2',[invoice('2624002303','186.400')],base)]);
assert.ok(result.blockers.some(e=>e.includes('مكرر')));
result=evaluateSerial([row(5,'2624002303','186.400')],[record('g1',[invoice('2624002303','186.400')],[{number:'2611001',paste:header+'\nDAR00001\tA\t1\tPiece\t001\t011\nDAR00002\tB\t1\tPiece\t002\t011'}])]);
assert.deepEqual(result.blockers,[],'Multiple valid directions in a single SAP transfer are not an error');
assert.equal(result.rows[0].transfers[0].kind,'adjustment','Mixed transfer is listed as adjustment, not falsely main or dry');
const group=record('g-multi',[invoice('2624002303','186.400'),invoice('2624002304','591.160')],
 [transfer('2612001','DAR00001','001','011'),transfer('2612002','DAR00002','002','011')],{
  pages:{'s:DAR00001':'1','s:DAR00002':'2'}, // Historical personal marks are ignored.
});
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[group]);
assert.deepEqual(result.blockers,[],'Personal page marks must never block invoice receipt');
assert.deepEqual(result.rows.map(r=>r.transfers),[[],[]],
 'A page number is not evidence of transfer ownership by an individual invoice');
assert.deepEqual(result.rows.map(r=>r.unassignedTransfers.map(t=>t.number)),
 [['2612001','2612002'],['2612001','2612002']]);
assert.deepEqual(result.count,{received:2,pending:0,missing:0,review:0});
// Regression fixture only: these transfers are NOT claims about live production.
const savedKhaled=record('saved-khaled-group',
 [invoice('2610013337','600.640'),invoice('2610013339','582.330')],
 [transfer('2615999','DAR00001','001','011')]);
const savedKarama=record('saved-karama-group',
 [invoice('2621609885','251.300'),invoice('2621609886','345.440')],
 [transfer('2615774','DAR00002','001','011')]);
const wrongExcelKhaled={...row(9,'2610013337','600.640'),originalTransfers:['2615774','2615773']};
const wrongExcelKarama={...row(10,'2621609885','251.300'),originalTransfers:['2615799']};
const projectWins=evaluateSerial([wrongExcelKhaled,wrongExcelKarama],[savedKhaled,savedKarama]);
assert.deepEqual(projectSerialTransferCells(projectWins.rows[0]),['2615999','','','','','',''],
 'Khaled transfer slots are rebuilt from its SAVED PROJECT record, never from its Excel K:Q guesses');
assert.deepEqual(projectSerialTransferCells(projectWins.rows[1]),['2615774','','','','','',''],
 '2615774 follows the saved Karama group, not an unrelated Excel Khaled cell');
assert.equal(projectWins.rows[0].groupId,'saved-khaled-group');
assert.equal(projectWins.rows[1].groupId,'saved-karama-group');
assert.equal(projectWins.blockers.length,0);
auditSerialExport(projectWins.rows.map(r=>({
 number:r.number,date:r.date,groupId:r.groupId,
 transfers:projectSerialTransferCells(r).flatMap(value=>value.match(/\\d{4,20}/g)||[]),
 confirmedTransfers:serialInvoiceColumns(r).filter(Boolean)
})));
const withoutPersonalPages={...JSON.parse(group.payload),pages:{'s:DAR00001':'99','s:DAR00002':'0'},
 soldierLineAllocations:{},soldierLineTotals:{},soldierManualLineKeys:[]};
const noPages=record('g-multi-nopage',withoutPersonalPages.invoices,withoutPersonalPages.transfers,withoutPersonalPages);
const same=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[noPages]);
assert.deepEqual(same.rows.map(r=>({state:r.state,transfers:serialInvoiceColumns(r)})),
 result.rows.map(r=>({state:r.state,transfers:serialInvoiceColumns(r)})),
 'Page markers and old soldier allocations must not change serial results');
assert.deepEqual(same.blockers,[]);
const ambiguous=record('g-ambiguous',[invoice('2624002303','186.400'),invoice('2624002304','591.160')],
 [transfer('2612001','DAR00001','001','011')]);
assert.deepEqual(evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[ambiguous]).blockers,[],
 'Shared but valid transfer is a group link, not an allocation error');
const legacyRecord=record('g-legacy',[
 {...invoice('2624002303','186.400'),date:'2026-11-09'},
 {...invoice('2624002304','591.160'),date:'2026-11-09'}
],[transfer('2612001','DAR00001','001','011'),transfer('2612002','DAR00002','002','011')]);
result=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[legacyRecord]);
assert.deepEqual(result.blockers,[]);
assert.equal(result.legacyWarnings.length,0,'No legacy page cutoff or warning is needed');
assert.deepEqual(result.rows.map(serialInvoiceColumns),[['2612001','2612002'],['2612001','2612002']]);
assert.deepEqual(result.rows.map(r=>r.transfers),[[],[]]);
const numbers=['2616429','2616430','2616428','2616431','2616527','2616405','2616406',
 '2616465','2616423','2616424','2616432','2616433','2616417','2616418','2616419','2616538','2616529'];
const seventeen=record('g17',[invoice('2624002303','186.400'),invoice('2624002304','591.160')],
 numbers.map(n=>transfer(n,'DAR00001','001','011')));
const seventeenResult=evaluateSerial([row(5,'2624002303','186.400'),row(6,'2624002304','591.160')],[seventeen]);
assert.deepEqual(seventeenResult.blockers,[],
 'Seventeen valid group transfers without invoice pages must not be errors');
assert.equal(seventeenResult.rows[0].unassignedTransfers.length,17);
assert.deepEqual(seventeenResult.count,{received:2,pending:0,missing:0,review:0});
assert.equal(new Set(serialInvoiceColumns(seventeenResult.rows[0]).filter(Boolean)).size,17);
const unapprovedOld=record('g-unapproved',[invoice('2624002303','186.400'),invoice('2624002304','591.160')],
 [transfer('2612001','DAR00001','001','011')],{summary:{status:'review'}});
assert.equal(evaluateSerial([row(5,'2624002303','186.400')],[unapprovedOld]).rows[0].state,'review',
 'A page bypass must never override an unapproved financial record');
const badTransfer=record('g-invalid',[invoice('2624002303','186.400')],[{number:'2612001',paste:'bad SAP lines'}]);
const badResult=evaluateSerial([row(5,'2624002303','186.400')],[badTransfer]);
assert.equal(badResult.rows[0].state,'review','Invalid transfer evidence remains a real blocker');
assert.ok(badResult.blockers.some(e=>e.includes('غير مقروءة')));
const savedButUnreadableGroup=record('g-saved-2615774',
 [invoice('2621609886','345.440'),invoice('2621609885','251.300')],
 [{number:'2615774',paste:'bad SAP lines'}]);
const sharedUnreadable=evaluateSerial([
 row(5,'2621609886','345.440'),row(6,'2621609885','251.300')
],[savedButUnreadableGroup]);
assert.deepEqual(sharedUnreadable.rows.map(r=>serialInvoiceColumns(r).filter(Boolean)),
 [['2615774'],['2615774']],
 'A saved group transfer must remain attached to both invoices even if SAP lines are unreadable');
assert.ok(sharedUnreadable.rows.every(r=>r.state==='review'),
 'Unreadable SAP detail must not be silently accepted as a verified match');
auditSerialExport(sharedUnreadable.rows.map(r=>({
 number:r.number,date:r.date,groupId:r.groupId,
 transfers:serialInvoiceColumns(r).filter(Boolean),
 confirmedTransfers:serialInvoiceColumns(r).filter(Boolean)
})));
assert.throws(()=>auditSerialExport([
 ...sharedUnreadable.rows.map(r=>({
  number:r.number,date:r.date,groupId:r.groupId,
  transfers:serialInvoiceColumns(r).filter(Boolean),
  confirmedTransfers:serialInvoiceColumns(r).filter(Boolean)
 })),
 {number:'2610013337',date:'2026-11-01',groupId:'different-group',
  transfers:['2615774'],confirmedTransfers:['2615774']}
]),/دون إثبات مجموعة/,
 'A transfer stored in a different group must still block export');
assert.deepEqual(serialInvoiceColumns({
 transfers:[{number:'2615908',kind:'main'}],
 unassignedTransfers:[{number:'2615908',kind:'main'},{number:'2615826',kind:'dry'}],
}),['2615908','2615826'],'Keep grouped warehouse columns without duplication');
// Omar's saved figures stay authoritative, while Saja's original cells are kept for comparison.
result=evaluateSerial([row(5,'2624002303','186.401')],[correct]);
assert.equal(result.rows[0].omarNumber,'2624002303');
assert.equal(result.rows[0].omarAmount,'186.400');
assert.equal(result.rows[0].amount,'186.401');
assert.equal(result.rows[0].state,'received_difference');
assert.equal(result.count.received,1);
const guessedSaja={...row(5,'2660506908','186.400'),originalTransfers:['2611001']};
result=evaluateSerial([guessedSaja],[correct]);
assert.equal(result.rows[0].state,'received_difference','A uniquely transfer-linked number discrepancy is received in yellow');
assert.equal(result.count.received,1,'Unique SAP transfer evidence counts a paper-confirmed invoice as received');
assert.equal(result.rows[0].number,'2660506908','Preserve the original Saja guess');
assert.equal(result.rows[0].omarNumber,'2624002303','Show Omar official invoice number via unique transfer');
assert.ok(serialReviewNote(result.rows[0]).includes('فرق رقم الفاتورة'));
const second=record('another',[invoice('2629999999','12.000')],[transfer('2611001','DAR00001','001','011')]);
result=evaluateSerial([guessedSaja],[correct,second]);
assert.equal(result.rows[0].state,'missing','Ambiguous transfer ownership must not guess Omar invoice');
assert.equal(result.rows[0].omarNumber,'');
assert.ok(evaluateSerial([row(5,'2624002303','186.400')],[record('broken',[invoice('2624002303','186.400')],[])])
 .rows[0].state==='review','No verified transfers must not produce a green invoice');
const clean=evaluateSerial([row(5,'2624002303','186.400')],[correct]).rows[0];
assert.equal(serialReviewNote(clean),'','Matched invoices must not clutter the sheet with duplicate values');
const amountMismatch=evaluateSerial([row(5,'2624002303','186.401')],[correct]).rows[0];
assert.equal(serialReviewNote(amountMismatch),'فرق المبلغ: عمر 186.400 د.أ، سجى 186.401 د.أ');
const wrongNumber=evaluateSerial([guessedSaja],[correct]).rows[0];
assert.equal(serialReviewNote(wrongNumber),'فرق رقم الفاتورة: عمر 2624002303، سجى 2660506908');
const bothWrong=evaluateSerial([{...guessedSaja,amount:'186.420'}],[correct]).rows[0];
assert.ok(serialReviewNote(bothWrong).includes('فرق رقم الفاتورة: عمر'));
assert.ok(serialReviewNote(bothWrong).includes('فرق المبلغ: عمر 186.400'));
assert.equal(bothWrong.state,'received_difference','Both discrepancies remain one received yellow invoice');
assert.equal(evaluateSerial([{...guessedSaja,amount:'186.420'}],[correct]).count.received,1);
assert.equal(serialReviewNote(evaluateSerial([row(5,'9999999999','2.000')],[correct]).rows[0]),'غير موجودة في سجل المطابقة؛ لا يمكن استنتاج وصول الورق من غياب التسجيل');
// The missing direction: saved project invoices absent from Saja must be exported too.
const dated=(number,amount,date='2026-11-09')=>({...invoice(number,amount),date,id:'i-'+number});
const projectOnly=record('only-project',[dated('2629999988','12.345')],[
 transfer('2619091','DAR00001','001','011'),transfer('2619092','DAR00002','002','011'),
 transfer('2619093','DAR00003','009','011'),
]);
const snapshot=JSON.stringify(projectOnly);
const joined=evaluateSerial([row(5,'2624002303','186.400')],[correct,projectOnly]);
assert.equal(joined.rows.length,1,'Original Saja rows keep their original positions and validation');
assert.deepEqual(joined.count,{received:1,pending:0,missing:0,review:0},'Project-only invoices must not inflate the received-from-Saja total');
assert.equal(joined.projectOnly.length,1);
assert.equal(joined.projectOnly[0].origin,'project');
assert.equal(joined.projectOnly[0].number,'2629999988');
assert.equal(joined.projectOnly[0].amount,'12.345');
assert.equal(joined.projectOnly[0].date,'2026-11-09');
assert.equal(joined.projectOnly[0].branch,'فرع تجريبي');
assert.deepEqual(serialInvoiceColumns(joined.projectOnly[0]),['2619091','2619092','2619093']);
assert.equal(serialReviewNote(joined.projectOnly[0]),'موجودة بالمشروع وغير موجودة بكشف سجى');
assert.equal(JSON.stringify(projectOnly),snapshot,'Export must not create or modify saved invoices');
const outside=record('outside',[dated('2629999977','3.000','2026-10-31')],[]);
const nextDay=record('next-day',[dated('2629999966','0','2026-11-10')],[transfer('2619094','DAR00004','001','011')]);
assert.equal(evaluateSerial([row(5,'2624002303','186.400')],[correct,outside,nextDay]).projectOnly.length,0,
 'Without a declared period, additions stay within the dates actually covered by Saja');
const wholeMonth=evaluateSerial([row(5,'2624002303','186.400')],[correct,outside,nextDay],{from:'2026-11-01',to:'2026-11-30'});
assert.deepEqual(wholeMonth.projectOnly.map(row=>row.number),['2629999966'],
 'The declared monthly period includes a project invoice on a day absent from Saja');
assert.equal(wholeMonth.projectOnly[0].amount,'0','A real zero amount must not disappear');
const originalBlue={...row(6,'2629999988','12.345'),origin:'project'};
const repeated=evaluateSerial([row(5,'2624002303','186.400'),originalBlue],[correct,projectOnly]);
assert.equal(repeated.projectOnly.length,0,'Re-uploading an export must not duplicate the blue invoice');
assert.equal(repeated.rows[1].origin,'project','Existing generated rows must retain their blue origin');
assert.equal(repeated.count.received,1,'A blue row must never become a Saja-provided invoice on repeat export');
const linkedDated={...correct,payload:JSON.stringify({...JSON.parse(correct.payload),invoices:[dated('2624002303','186.400')]})};
assert.equal(evaluateSerial([guessedSaja],[linkedDated]).projectOnly.length,0,
 'A Saja number typo uniquely linked by transfer must not append the same saved invoice again');
const duplicateProject=record('duplicate-project',[dated('2629999988','12.345')],[transfer('2619095','DAR00001','001','011')]);
const duplicateResult=evaluateSerial([row(5,'2624002303','186.400')],[correct,projectOnly,duplicateProject]);
assert.equal(duplicateResult.projectOnly.length,1,'Each project-only invoice number is exported once despite duplicate saved records');
assert.equal(duplicateResult.projectOnly[0].number,'2629999988');
assert.ok(serialReviewNote(duplicateResult.projectOnly[0]).includes('مكرر في سجلات المشروع'));
assert.deepEqual(serialInvoiceColumns(duplicateResult.projectOnly[0]),
 ['2619091','2619092','2619095','2619093'],'Every conflicting source transfer stays visible, sorted by main/dry/adjustment columns');
assert.ok(duplicateResult.blockers.some(message=>message.includes('2629999988')&&message.includes('مكرر')));
const disagreement=record('duplicate-amount',[dated('2629999988','13.200')],[transfer('2619096','DAR00001','001','011')]);
const conflicting=evaluateSerial([row(5,'2624002303','186.400')],[correct,projectOnly,disagreement]);
assert.equal(conflicting.projectOnly.length,1,'A contradictory amount must never generate a second invoice number');
assert.ok(serialReviewNote(conflicting.projectOnly[0]).includes('12.345 / 13.200'),
 'Both saved amounts remain in the conflict note');
assert.equal(conflicting.projectOnly[0].state,'review','Conflicted records must not silently become matched');
assert.equal(new Set(conflicting.projectOnly.map(item=>item.number)).size,conflicting.projectOnly.length);
const onSaja=evaluateSerial([row(5,'2629999988','12.345')],[projectOnly,disagreement]);
assert.equal(onSaja.projectOnly.length,0,'A number found in Saja must never be re-appended in blue');
assert.equal(onSaja.rows[0].state,'review','A stored duplicate found in Saja requires review');
assert.ok(onSaja.rows[0].reason.includes('13.200'),'Saja reviewer sees the saved conflict');
// A prior export may already contain an incorrectly appended blue copy of a
// real Saja invoice. Retain the original Saja row, discard only generated copies.
const oldExportRows=[
 row(136,'2621610051','176.920'),
 {...row(493,'2621610051','176.920'),origin:'project'},
 {...row(494,'2621610052','20.000'),origin:'project'},
 {...row(495,'2621610052','20.000'),origin:'project'},
 row(496,'2621610053','30.000'),
 row(497,'2621610053','30.000'),
];
assert.deepEqual([...duplicateGeneratedSerialRows(oldExportRows)],
 [[493,136],[495,494]],
 'Remove only duplicate previously generated blue rows; never remove genuine repeated Saja originals');
assert.equal(duplicateGeneratedSerialRows([row(136,'2621610051','176.920')]).size,0);
assert.equal(duplicateGeneratedSerialRows([{...row(493,'2621610051','176.920'),origin:'project'}]).size,0);
assert.equal(duplicateGeneratedSerialRows([
 {...row(493,'2621610051','176.920'),origin:'project'},row(136,'2621610051','176.920')
]).get(493),136,'Real Saja row always wins, regardless of source order');
const proposal=serialMergeProposals([
 {...row(144,'2621610051','176.920'),workbookBranch:'مجمع الكرامة'},
 {...row(497,'2621610051','176.92'),origin:'project',workbookBranch:'مجمع الكرامة'},
 {...row(498,'2621111100','8.000'),origin:'project'},
]);
assert.equal(proposal.length,1,'Find exactly one proposed merge for an existing Saja invoice and generated duplicate');
assert.equal(proposal[0].number,'2621610051');
assert.equal(proposal[0].keepRow,144,'Keep the original Saja row instead of generated blue duplicate');
assert.deepEqual(proposal[0].removeRows,[497]);
assert.equal(proposal[0].canMerge,true,'Matching amounts with different decimal precision are safe after approval');
assert.equal(serialMergeProposals([
 {...row(144,'2621610051','176.920'),workbookBranch:'فرع أ'},
 {...row(497,'2621610051','177.000'),origin:'project',workbookBranch:'فرع أ'},
])[0].canMerge,false,'Conflicting amounts must not be merged with a single button');
assert.equal(serialMergeProposals([
 {...row(144,'2621610051','176.920'),workbookBranch:'مجمع الكرامة التجاري'},
 {...row(497,'2621610051','176.920'),origin:'project',workbookBranch:'1 — الكرامة'},
])[0].canMerge,true,'Different generated branch aliases may merge after approval and must be noted');
assert.equal(serialMergeProposals([
 {...row(144,'2621610051','176.920'),workbookBranch:'فرع أ'},
 {...row(497,'2621610051','176.920'),workbookBranch:'فرع ب'},
])[0].canMerge,false,'Different ORIGINAL Saja branches block an automatic merge');
assert.equal(serialMergeProposals([
 {...row(144,'2621610051','176.920'),date:'2026-11-07'},
 {...row(497,'2621610051','176.920'),date:'2026-11-08',origin:'project'},
])[0].canMerge,false,'Different dates block approval');
assert.equal(serialMergeProposals([
 row(144,'2621610051','176.920'),row(497,'2621610051','176.920')
])[0].canMerge,true,'Original duplicate Saja rows can be proposed when amounts and dates agree');
const acceptedCase=[
 {...row(144,'2621610051','176.920'),workbookBranch:'مجمع الكرامة التجاري'},
 {...row(497,'2621610051','176.92'),origin:'project',workbookBranch:'1 — الكرامة'},
];
const consentName='16.11-جندي-السيريل-جندي-السيريل.xlsx';
assert.deepEqual(previouslyApprovedSerialMerges(acceptedCase,consentName),['2621610051'],
 'Chat consent applies ONLY to the exact previously reported row pair with a generated blue duplicate');
assert.deepEqual(previouslyApprovedSerialMerges(acceptedCase,'17.11-جندي-السيريل-جندي-السيريل.xlsx'),[],
 'Future and other files must never inherit chat approval');
assert.deepEqual(previouslyApprovedSerialMerges(acceptedCase.map(r=>({...r,row:r.row===497?498:r.row})),consentName),[],
 'New or shifted duplicate rows require another explicit approval');
assert.deepEqual(previouslyApprovedSerialMerges(acceptedCase.map(r=>({...r,origin:undefined})),consentName),[],
 'Two original Saja invoices must never be merged by the stored approval');
assert.deepEqual(previouslyApprovedSerialMerges(acceptedCase.map(r=>({...r,amount:r.row===497?'177.000':r.amount})),consentName),[],
 'Conflicting amounts override previously supplied consent');
assert.deepEqual(previouslyApprovedSerialMerges(acceptedCase.map(r=>({...r,date:r.row===497?'2026-11-10':r.date})),consentName),[],
 'Conflicting dates override previously supplied consent');

const physical=(number,date,groupId,transfers,confirmedTransfers=transfers)=>({number,date,groupId,transfers,confirmedTransfers});
const dayA='2026-11-01',dayB='2026-11-02';
assert.deepEqual(serialWorkingDays({from:'2026-11-01',to:'2026-11-14'},[dayA,dayB]),
 ['2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05',
  '2026-11-07','2026-11-08','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-14'],
 'Both November 6 and 13 (Fridays) must be excluded; all other days get tabs');
assert.throws(()=>serialWorkingDays({from:'2026-11-01',to:'2026-11-30'},['2026-11-06']),/الجمعة/,
 'Friday invoices must never be silently omitted or moved');
assert.throws(()=>serialWorkingDays({from:'2026-11-01',to:'2026-11-30'},['2026-12-01']),/خارج فترة/,
 'Out-of-range dates must never be silently omitted');
auditSerialExport([physical('2621111101',dayA,'grp1',['1234'],['1234']),
 physical('2621111102',dayB,'grp1',['1234'],['1234'])]);
assert.throws(()=>auditSerialExport([physical('2621111101',dayA,'grp1',['1234']),
 physical('2621111102',dayB,'grp2',['1234'])]),/دون إثبات مجموعة/,
 'Shared transfers across different groups are prohibited');
assert.throws(()=>auditSerialExport([physical('2621111101',dayA,'grp1',['1234']),
 physical('2621111102',dayB,'grp1',['1234'],[])]),/دون إثبات مجموعة/,
 'A stale Saja transfer number is NOT sufficient group evidence');
assert.throws(()=>auditSerialExport([physical('2621111101',dayA,'grp1',['1234']),
 physical('2621111101',dayB,'grp1',['1234'])]),/رقم الفاتورة/,
 'Same invoice number across two different day sheets is prohibited');
assert.throws(()=>auditSerialExport([physical('2621111101',dayA,'grp1',['1234','1234'])]),/مرتين/,
 'A transfer repeated inside one row is prohibited');
assert.throws(()=>auditSerialExport([physical('2621111101',dayA,'grp1',['1234'],['1234','1235'])]),/مفقود/,
 'Truncating verified project transfer numbers must block download');
console.log('PASS: final Excel audit enforces globally unique invoice numbers and verified shared-group exceptions.');
console.log('PASS: daily sheets skip November Fridays without losing or moving Friday-dated invoices.');

console.log('PASS: only exception rows receive concise Omar-vs-Saja notes, including three-decimal amounts');
console.log('PASS: confirmed arrival is counted despite amount/number differences while uncertain links remain unresolved');
console.log('PASS: serial soldier ignores ALL personal pages for both historical and new groups while retaining true validation errors');
console.log('PASS: project-only invoices, declared date ranges, repeat exports, transfer-linked typos, duplicate records and read-only export.');
