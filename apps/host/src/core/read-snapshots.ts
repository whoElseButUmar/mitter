import {randomBytes} from 'node:crypto';
import type {Action,Envelope,Project,Worker} from '../../../../packages/protocol/src/index.js';
import {isReadReference,type ProposalEnvelope} from '../../../../packages/protocol/src/proposal.js';
import {ReplyValidationError} from '../../../../packages/protocol/src/validation.js';
import {Store} from './database.js';
import {fileText,validateRelative} from './workspace.js';
import {redact} from './redaction.js';

interface ReadVersion {base:string;path:string;hash:string;characters:number;redacted:boolean;ranges:[number,number][]}
interface Ledger {version:1;workerId:string;projectId:string;runId:string;epoch:number;root:string;reads:ReadVersion[]}
const key=(workerId:string)=>'miter.readSnapshots.v1.'+workerId;
function covers(ranges:[number,number][],length:number):boolean{return ranges.length===1&&ranges[0]![0]===0&&ranges[0]![1]===length;}
function merge(ranges:[number,number][],start:number,end:number):[number,number][] {
  const sorted=[...ranges,[start,end] as [number,number]].sort((a,b)=>a[0]-b[0]),out:[number,number][]=[];
  for(const r of sorted){const prev=out.at(-1);if(prev&&prev[1]>=r[0])prev[1]=Math.max(prev[1],r[1]);else out.push([...r]);}
  return out;
}
const safeBoundary=(s:string,at:number)=>at>0&&at<s.length&&/[\uD800-\uDBFF]/.test(s[at-1]!)&&/[\uDC00-\uDFFF]/.test(s[at]!)?at-1:at;

/** Body-free persistent read ledger. References identify an immutable READ, not
 * the latest file. Lookup is synchronous and never reads/rebases the live file.
 * The existing lock + hash + journal preflight still checks actual bytes. */
export class ReadSnapshots {
  constructor(private store:Store){}
  private ledger(w:Worker,p:Project):Ledger {
    const raw=this.store.get<Ledger>(key(w.id));
    const empty:Ledger={version:1,workerId:w.id,projectId:w.projectId,runId:w.runId,epoch:w.control?.epoch??0,root:p.root,reads:[]};
    if(!raw)return empty;
    if(raw.version!==1||!Array.isArray(raw.reads)||raw.reads.length>128)throw Error('File read records are not valid. No file versions were inferred.');
    if(raw.workerId!==w.id||raw.projectId!==w.projectId||raw.runId!==w.runId||raw.epoch!==(w.control?.epoch??0)||raw.root!==p.root)return empty;
    const bases=new Set<string>();
    for(const r of raw.reads){
      if(!r||!isReadReference(r.base)||bases.has(r.base)||typeof r.path!=='string'||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash)||
        !Number.isSafeInteger(r.characters)||r.characters<0||r.characters>120000||typeof r.redacted!=='boolean'||!Array.isArray(r.ranges)||r.ranges.length>128||
        !r.ranges.every(a=>Array.isArray(a)&&a.length===2&&a.every(Number.isSafeInteger)&&a[0]>=0&&a[1]>=a[0]&&a[1]<=r.characters))throw Error('File read records are not valid. No file versions were inferred.');
      validateRelative(r.path);bases.add(r.base);
    }
    return raw;
  }
  async read(w:Worker,p:Project,a:Extract<Action,{type:'read'}>,signal:AbortSignal):Promise<unknown> {
    validateRelative(a.path);
    const epoch=w.control?.epoch??0,runId=w.runId;
    const f=await fileText(p.root,a.path),visible=redact(f.content),redacted=visible!==f.content;
    signal.throwIfAborted();
    if((w.control?.epoch??0)!==epoch||w.runId!==runId)throw Error('This read belongs to a superseded task run.');
    const offset=a.offset??0;
    if(offset>visible.length||safeBoundary(visible,offset)!==offset)throw new Error('Read offset is outside this file or splits a Unicode character. Read from offset 0 again.');
    const ledger=this.ledger(w,p);
    let record=ledger.reads.find(r=>r.path===a.path&&r.hash===f.hash&&r.redacted===redacted&&r.characters===visible.length);
    if(!record){let base:string;do{base='r_'+randomBytes(8).toString('hex');}while(ledger.reads.some(r=>r.base===base));record={base,path:a.path,hash:f.hash,characters:visible.length,redacted,ranges:[]};ledger.reads.push(record);}
    // Budget the SERIALIZED page (quotes/backslashes/control characters count).
    // Existing source-byte limits are unchanged. UTF-16 offsets match the UI.
    const limit=Math.min(a.limit??(w.mode==='local'?6000:32000),w.mode==='local'?6000:64000);
    const budget=w.mode==='local'?16000:47000;
    let end=safeBoundary(visible,Math.min(visible.length,offset+limit));
    // A one-unit limit may land before a surrogate pair; include it atomically.
    if(end===offset&&offset<visible.length)end=Math.min(visible.length,offset+2);
    const page=()=>({hash:f.hash,base:record!.base,offset,end,totalCharacters:visible.length,complete:offset===0&&end===visible.length,
      ...(end<visible.length?{nextOffset:end}:{}),...(redacted?{redacted:true,warning:'Credential-like content was masked. Full-file writes using this base are disabled; exact non-sensitive replacements still require unique matches.'}:{}),content:visible.slice(offset,end)});
    while(JSON.stringify({action:a,result:page()}).length>budget&&end>offset)end=safeBoundary(visible,offset+Math.floor((end-offset)*0.85));
    if(end===offset&&offset<visible.length)throw Error('The requested read cannot fit safely. Use a smaller path or read range.');
    record.ranges=merge(record.ranges,offset,end);
    if(record.ranges.length>128)throw Error('Too many disjoint read ranges. Read consecutive pages instead.');
    const result={...page(),readComplete:covers(record.ranges,record.characters)&&!redacted};
    ledger.reads=ledger.reads.slice(-128);this.store.set(key(w.id),ledger);
    return result;
  }
  resolve(w:Worker,p:Project,proposal:ProposalEnvelope):Envelope {
    const ledger=this.ledger(w,p);
    const actions:Action[]=proposal.actions.map((a,index)=>{
      if(!('base' in a))return a;
      if(a.base==='missing'&&a.type==='write')return {type:a.type,path:a.path,content:a.content,expectedHash:'missing'};
      const r=['complete','cancelled'].includes(w.state)?undefined:ledger.reads.find(r=>r.base===a.base&&r.path===a.path);
      if(!r)throw new ReplyValidationError({stage:'precondition',code:'BASE_UNAVAILABLE',field:'base',actionIndex:index,message:'This base is not a recorded read of this file in the current task/run. Read the file again. No file was changed.'});
      if(a.type==='write'&&(!covers(r.ranges,r.characters)||r.redacted))throw new ReplyValidationError({stage:'precondition',code:'BASE_INCOMPLETE',field:'base',actionIndex:index,message:'A full-file write needs a complete, unredacted read. Read the remaining pages, or use an exact replacement in the portion already inspected.'});
      return a.type==='write'?{type:a.type,path:a.path,content:a.content,expectedHash:r.hash}:
        {type:a.type,path:a.path,before:a.before,after:a.after,expectedHash:r.hash};
    });
    return {...proposal,actions};
  }
}
