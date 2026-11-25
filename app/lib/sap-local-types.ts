export type SapLocalReference = {number:string;hash:string};
export type SapLocalSnapshot = {key:string;created:string;committed:string;documents:number;activeCount:number};
export type SapLocalReport = {
  sourceCount:number; baselineCount:number; added:number; changed:number; unchanged:number;
  missing:number; excluded:number; reverse:number; canceled:number; issueCount:number;
  issues:string[]; addedNumbers:string[]; changedNumbers:string[]; missingNumbers:string[];
  excludedNumbers:string[]; sourceKind:'unified'|'transfers'; elapsedMs:number;
};
export type SapLocalRequest = {text:string; branches:string[]; baseline:SapLocalReference[]};
export type SapLocalEvent =
  | {type:'progress';done:number;total:number}
  | {type:'done';report:SapLocalReport}
  | {type:'error';message:string};
