import os from 'node:os';
import path from 'node:path';
import {promises as fs, constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {loadPtyRuntime} from './pty-runtime.js';
import type {Snapshot} from '../../../../packages/protocol/src/index.js';
import {terminalObject,terminalFields,terminalId,dimension,MAX_INPUT,type TerminalInfo,type TerminalRead,type TerminalFrame} from '../../../../packages/terminal/src/protocol.js';

export interface PtyProcess {
  pid:number; write(data:string):void; resize(cols:number,rows:number):void;
  kill(signal?:string):void; pause():void; resume():void;
  onData(fn:(data:string)=>void):{dispose():void};
  onExit(fn:(event:{exitCode:number;signal?:number})=>void):{dispose():void};
}
export interface PtyFactory { spawn(shell:string,args:string[],options:{name:string;cwd:string;env:Record<string,string>;cols:number;rows:number;encoding:'utf8'}):PtyProcess }
interface Session {
  info:Omit<TerminalInfo,'owned'|'occupied'>; pty:PtyProcess; owner?:string;
  frames:TerminalFrame[]; next:number; ack:number; delivered:number; bytes:number;
  subscriptions:{dispose():void}[]; closed:boolean;
}
const HIGH_WATER=512*1024,LOW_WATER=128*1024,HISTORY=128*1024,READ_LIMIT=64*1024;
/** Real PTYs live only in this host. Buffers are bounded, in memory, never in
 * snapshots, reports, the debug console or SQLite. No model holds this object. */
export class TerminalManager {
  private sessions=new Map<string,Session>();
  private loading?:Promise<PtyFactory>;private disposed=false;private creating=0;
  constructor(private snapshot:()=>Snapshot,private load:()=>Promise<PtyFactory>=loadPtyRuntime){}
  async dispatch(method:string,raw:unknown):Promise<unknown> {
    if(this.disposed)throw Error('The terminal host is closed.');
    const p=terminalObject(raw),clientId=terminalId(p.clientId);
    switch(method){
      case 'terminal.list':terminalFields(p,['clientId','projectId']);return this.list(clientId,p.projectId===undefined?undefined:terminalId(p.projectId));
      case 'terminal.create':terminalFields(p,['clientId','projectId','workerId','cols','rows','confirm']);
        if(p.confirm!==true)throw Error('Starting a real local shell requires your confirmation.');
        return this.create(clientId,terminalId(p.projectId),p.workerId===undefined?undefined:terminalId(p.workerId),dimension(p.cols,10,500),dimension(p.rows,2,300));
      case 'terminal.attach':terminalFields(p,['clientId','sessionId']);return this.attach(clientId,terminalId(p.sessionId));
      case 'terminal.read':terminalFields(p,['clientId','sessionId','after']);return this.read(clientId,terminalId(p.sessionId),dimension(p.after,0,Number.MAX_SAFE_INTEGER));
      case 'terminal.write':terminalFields(p,['clientId','sessionId','data']);{
        const s=this.owned(clientId,terminalId(p.sessionId));
        if(s.info.exited)throw Error('This shell has exited. Open a new terminal.');
        if(typeof p.data!=='string'||p.data.length>MAX_INPUT)throw Error('Terminal input is too large.');
        // Raw user input, including control characters, goes to the PTY—not a shell command wrapper.
        s.pty.write(p.data);return {written:true};
      }
      case 'terminal.resize':terminalFields(p,['clientId','sessionId','cols','rows']);{
        const s=this.owned(clientId,terminalId(p.sessionId)),cols=dimension(p.cols,10,500),rows=dimension(p.rows,2,300);
        if(!s.info.exited)s.pty.resize(cols,rows);s.info.cols=cols;s.info.rows=rows;return {resized:true};
      }
      case 'terminal.close':terminalFields(p,['clientId','sessionId','confirm']);{
        if(p.confirm!==true)throw Error('Closing a shell requires confirmation.');
        const s=this.owned(clientId,terminalId(p.sessionId));this.closeSession(s);return {closed:true};
      }
      case 'terminal.release':terminalFields(p,['clientId','sessionId']);{
        const s=this.owned(clientId,terminalId(p.sessionId));s.owner=undefined;return {released:true};
      }
      case 'terminal.disconnect':terminalFields(p,['clientId']);for(const s of this.sessions.values())if(s.owner===clientId)s.owner=undefined;return {released:true};
      default:throw Error('Unsupported terminal operation.');
    }
  }
  private list(clientId:string,projectId?:string):TerminalInfo[]{return [...this.sessions.values()].filter(s=>!projectId||s.info.projectId===projectId).map(s=>({...s.info,owned:s.owner===clientId,occupied:!!s.owner&&s.owner!==clientId}));}
  private owned(clientId:string,id:string):Session {
    const s=this.sessions.get(id);if(!s||s.closed)throw Error('This terminal no longer exists.');
    if(s.owner!==clientId)throw Error('This terminal is attached to another view. Close or release that view first.');return s;
  }
  private async create(clientId:string,projectId:string,workerId:string|undefined,cols:number,rows:number):Promise<TerminalInfo>{
    if(this.sessions.size+this.creating>=8)throw Error('Close a terminal before opening another (maximum 8).');
    this.creating++;
    try{
      const snapshot=this.snapshot(),project=snapshot.projects.find(p=>p.id===projectId);
      if(!project)throw Error('Open a registered project first.');
      const worker=workerId?snapshot.workers.find(w=>w.id===workerId&&w.projectId===projectId):undefined;
      if(workerId&&!worker)throw Error('The task does not belong to this project.');
      const requested=worker?.worktree?.root||project.root,cwd=await fs.realpath(requested);
      if(cwd!==requested||!(await fs.stat(cwd)).isDirectory())throw Error('The project folder changed. Reopen it before starting a shell.');
      let shell=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):(os.userInfo().shell||process.env.SHELL||(process.platform==='darwin'?'/bin/zsh':'/bin/bash'));
      if(!path.isAbsolute(shell)||/[\0\r\n]/.test(shell))throw Error('Your login shell path is invalid.');
      await fs.access(shell,constants.X_OK);
      const factory=await (this.loading??=this.load().catch(error=>{this.loading=undefined;throw error;}));
      if(this.disposed)throw Error('The terminal host closed while starting.');
      // Normal user environment is intentional for a human-operated shell. It is
      // not returned by any RPC and never forwarded to the coding agent.
      const env:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined)env[key]=value;
      delete env.NODE_OPTIONS;delete env.ELECTRON_RUN_AS_NODE;
      env.TERM='xterm-256color';env.COLORTERM='truecolor';env.TERM_PROGRAM='Miter';
      const pty=factory.spawn(shell,process.platform==='win32'?['-NoLogo']:['-l'],{name:'xterm-256color',cwd,env,cols,rows,encoding:'utf8'});
      const id=randomUUID(),s:Session={info:{id,projectId,workerId,title:path.basename(shell),cwd,shell,pid:pty.pid,cols,rows,createdAt:Date.now(),exited:false,paused:false},pty,owner:clientId,frames:[],next:0,ack:0,delivered:0,bytes:0,subscriptions:[],closed:false};
      this.sessions.set(id,s);
      s.subscriptions.push(pty.onData(data=>this.output(s,data)),pty.onExit(e=>{if(s.closed)return;s.info.exited=true;s.info.exitCode=e.exitCode;s.info.paused=false;}));
      return {...s.info,owned:true,occupied:false};
    }finally{this.creating--;}
  }
  private output(s:Session,data:string){
    if(s.closed||!data)return;
    // node-pty decodes UTF-8. Split without tearing UTF-16 surrogate pairs.
    for(let offset=0;offset<data.length;){let end=Math.min(offset+8192,data.length);if(end<data.length&&/[\uD800-\uDBFF]/.test(data[end-1]!))end--;const text=data.slice(offset,end);offset=end;s.frames.push({seq:++s.next,data:text});s.bytes+=text.length*2;}
    const unack=s.frames.reduce((n,f)=>n+(f.seq>s.ack?f.data.length*2:0),0);
    if(unack>=HIGH_WATER&&!s.info.paused&&!s.info.exited){s.pty.pause();s.info.paused=true;}
    // A native producer ignoring pause is terminated, never allowed unbounded memory.
    if(s.bytes>HIGH_WATER*4){s.info.exited=true;s.info.exitCode=-1;try{s.pty.kill();}catch{}s.frames=s.frames.slice(-32);s.bytes=s.frames.reduce((n,f)=>n+f.data.length*2,0);}
    this.trim(s);
  }
  private trim(s:Session){while(s.bytes>HISTORY&&s.frames.length>1&&s.frames[0]!.seq<=s.ack){s.bytes-=s.frames.shift()!.data.length*2;}}
  private attach(clientId:string,id:string):TerminalInfo {
    const s=this.sessions.get(id);if(!s||s.closed)throw Error('This terminal no longer exists.');
    if(s.owner&&s.owner!==clientId)throw Error('This terminal is open in another Miter view. Close its view first, or open another shell.');
    s.owner=clientId;s.delivered=s.ack;return {...s.info,owned:true,occupied:false};
  }
  private read(clientId:string,id:string,after:number):TerminalRead {
    const s=this.owned(clientId,id);
    if(after>s.delivered)throw Error('Terminal acknowledgement is ahead of delivered output.');
    if(after>s.ack){s.ack=after;this.trim(s);}
    const first=s.frames[0]?.seq??s.next+1,reset=after<first-1;
    const frames:TerminalFrame[]=[];let bytes=0;
    for(const frame of s.frames){if(frame.seq<=after)continue;if(bytes&&bytes+frame.data.length*2>READ_LIMIT)break;frames.push(frame);bytes+=frame.data.length*2;}
    if(frames.length)s.delivered=Math.max(s.delivered,frames.at(-1)!.seq);
    const unack=s.frames.reduce((n,f)=>n+(f.seq>s.ack?f.data.length*2:0),0);
    if(s.info.paused&&unack<LOW_WATER&&!s.info.exited){s.info.paused=false;s.pty.resume();}
    return {frames,exited:s.info.exited&&(frames.at(-1)?.seq??after)>=s.next,exitCode:s.info.exitCode,reset,paused:s.info.paused};
  }
  private closeSession(s:Session){s.closed=true;this.sessions.delete(s.info.id);for(const d of s.subscriptions)d.dispose();s.frames=[];s.bytes=0;try{if(!s.info.exited)s.pty.kill();}catch{}}
  async reset():Promise<void>{
    this.disposed=true;
    const failures:string[]=[];
    await Promise.all([...this.sessions.values()].map(async s=>{
      if(s.info.exited){this.closeSession(s);return;}
      try{
        await new Promise<void>((resolve,reject)=>{
          let done=false;let sub:{dispose():void}|undefined;
          const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);sub?.dispose();error?reject(error):resolve();};
          const timer=setTimeout(()=>finish(Error('Shell did not confirm exit')),5000);
          sub=s.pty.onExit(()=>{s.info.exited=true;finish();});
          try{s.pty.kill('SIGKILL');}catch(e){finish(e instanceof Error?e:Error(String(e)));}
        });
        this.closeSession(s);
      }catch(e){failures.push(`Terminal ${s.info.id} (PID ${s.info.pid}): ${String(e)}`);}
    }));
    if(failures.length)throw Error(failures.join('\n'));
  }
  close(){this.disposed=true;for(const s of [...this.sessions.values()])this.closeSession(s);}
}
