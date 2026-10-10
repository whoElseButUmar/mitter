import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { listFiles } from './workspace.js';
import type { Profile } from '../../../../packages/protocol/src/index.js';
import { integer,object,only,text,id } from '../../../../packages/protocol/src/index.js';
import { RedactedOutput } from './redaction.js';
export { redact } from './redaction.js';
/** Best-effort refusal list, NOT a sandbox. A basename blocklist cannot prove
 * safety: reviewed approval of the full program+argv is the actual control, and
 * any approved program runs with your OS user permissions. See README.md. */
const BLOCKED_PROGRAMS=new Set([
  // privilege escalation and direct deletion
  'sudo','su','doas','runuser','rm','del','rmdir','rd','kill','pkill','killall','taskkill','shutdown','reboot','halt','poweroff','format','diskpart',
  // shells and Windows script hosts
  'sh','bash','zsh','fish','csh','tcsh','ksh','dash','ash','busybox','cmd','command','powershell','pwsh','mshta','wscript','cscript','rundll32','regsvr32','reg',
  // process launchers that smuggle a blocked program past the basename check
  'env','nice','nohup','stdbuf','timeout','watch','xargs','parallel','setsid','script','expect','screen','tmux','dtach','daemonize',
  // remote access, transfer and download
  'ssh','scp','sftp','rsync','ftp','tftp','telnet','nc','ncat','netcat','socat','curl','wget','fetch','aria2c','axel',
  // arbitrary-code interpreters that are not the reviewed-script runtime
  'osascript','osacompile','awk','gawk','mawk','perl','ruby','php','lua','luajit','rscript','r','jshell','ghci','abcl','tclsh','wish',
  // schedulers and service control
  'crontab','at','launchctl','systemctl','service','schtasks','anacron',
]);
/** Interpreters allowed as programs (reviewed script files), with the inline
 * flags that would turn an argument into arbitrary code. */
const INTERPRETER_INLINE=new Map<string,RegExp>([
  ['node',/^(?:--(?:eval|print|require|import|loader|experimental-loader)(?:=|$)|-(?:e|p|r|c)(?:[^-].*)?$)/],
  ['deno',/^(?:eval|repl)(?:$|,)|^-e/],
  ['bun',/^(?:--eval|-e(?:$|=)|--require|-r(?:$|=))/],
  ['python',/^-(?:c|m=|i$)/],
  ['python3',/^-(?:c|m=|i$)/],
  ['python3.11',/^-(?:c|m=|i$)/],
]);
export function parseProfile(value:unknown):Profile {
  const p=object(value,'command profile'); only(p,['id','label','program','args','timeoutMs']);
  const program=text(p.program,'program',1000);
  const base=path.basename(program).toLowerCase().replace(/\.(exe|cmd|bat)$/,'');
  if(BLOCKED_PROGRAMS.has(base)) throw new Error('This program is refused as a common shell, launcher, remote, download, or arbitrary-code shortcut. Register the specific tool you reviewed instead; approval of the full program and arguments is the real control, and every approved command runs with your OS user permissions.');
  if(!Array.isArray(p.args)||p.args.length>50)throw new Error('Provide at most 50 arguments as a JSON array.');
  const args=p.args.map(a=>text(a,'argument',4000,true));
  const inline=INTERPRETER_INLINE.get(base);
  if(inline&&args.some(a=>inline.test(a)))throw new Error('Inline code execution and injected loaders are disabled. Use a reviewed project script.');
  if(base==='git') {
    if(args.some(a=>['push','reset','clean','checkout','restore','rebase','merge','config','filter-branch','upload-archive'].includes(a))||args.includes('-c')||args.includes('--exec-path'))
      throw new Error('Destructive, remote, configurable, and helper-executing Git operations are disabled.');
  }
  if(base==='find'&&args.some(a=>['-delete','-exec','-execdir','-ok','-okdir','-fprintf'].includes(a)))
    throw new Error('find is limited to reading: -delete and -exec families are disabled.');
  return {id:id(p.id),label:text(p.label,'label',80),program,args,timeoutMs:integer(p.timeoutMs??120000,'timeout',1000,600000)};
}
export interface CommandResult { code:number|null; stdout:string; stderr:string; timedOut:boolean; aborted:boolean }
export async function runCommand(profile:Profile,root:string,scratch:string,signal:AbortSignal,onOutput?:(line:string)=>void):Promise<CommandResult> {
  signal.throwIfAborted(); await fs.mkdir(scratch,{recursive:true}); signal.throwIfAborted();
  // No inherited API keys, NODE_OPTIONS, PYTHONPATH, or credential-bearing environment.
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:scratch,USERPROFILE:scratch,TMPDIR:scratch,TMP:scratch,TEMP:scratch,LANG:'C.UTF-8',CI:'1',NO_COLOR:'1',GIT_TERMINAL_PROMPT:'0'};
  if(process.platform==='win32') { env.SystemRoot=process.env.SystemRoot; env.WINDIR=process.env.WINDIR; env.PATHEXT=process.env.PATHEXT; }
  let program=profile.program,args=[...profile.args];
  // Windows npm/pnpm .cmd files need a shell. We refuse that implicit fallback.
  if(process.platform==='win32' && /^(npm|pnpm|yarn)(\.cmd)?$/i.test(program)) throw new Error('On Windows use node.exe with the absolute path to the package manager .cjs/.js entrypoint as its first argument. See SETUP.md.');
  return await new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd:root,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let out='',err='',timedOut=false,aborted=false,settled=false; let outputError:unknown; let stopping=false; let hardTimer:ReturnType<typeof setTimeout>|undefined;
    const kill=(hard=false)=>{
      if(!child.pid)return;
      try {
        if(process.platform==='win32') {
          // child.kill() only reaches the direct child; npm→tsc→esbuild trees
          // survive it. taskkill /T walks the whole descendant tree.
          spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
        } else process.kill(-child.pid,hard?'SIGKILL':'SIGTERM');
      } catch { /* already exited */ }
    };
    const stop=()=>{if(stopping)return;stopping=true;kill();hardTimer=setTimeout(()=>kill(true),1000);hardTimer.unref();};
    const timer=setTimeout(()=>{timedOut=true;stop();},profile.timeoutMs);timer.unref();
    const abort=()=>{aborted=true;stop();}; signal.addEventListener('abort',abort,{once:true});
    const collect=(kind:'out'|'err',s:string)=>{
      if(kind==='out')out=(out+s).slice(-24000); else err=(err+s).slice(-24000);
      if(outputError===undefined)try{onOutput?.(s.slice(0,3000));}catch(error){outputError=error??new Error('Command output reporting failed.');stop();}
    };
    const stdout=new RedactedOutput(s=>collect('out',s)),stderr=new RedactedOutput(s=>collect('err',s));
    child.stdout.on('data',c=>stdout.push(c));child.stderr.on('data',c=>stderr.push(c));
    child.stdout.once('end',()=>stdout.end());child.stderr.once('end',()=>stderr.end());
    const clean=()=>{clearTimeout(timer);if(hardTimer)clearTimeout(hardTimer);signal.removeEventListener('abort',abort);};
    child.on('error',error=>{if(!settled){settled=true;clean();reject(error);}});
    child.on('close',code=>{if(!settled){settled=true;kill(true);clean();if(outputError!==undefined)reject(outputError);else resolve({code,stdout:out,stderr:err,timedOut,aborted});}});
  });
}
export async function gitDiff(root:string,scratch:string,signal:AbortSignal):Promise<CommandResult> {
  const files=await listFiles(root,'.',100);
  return runCommand({id:'internal-diff',label:'Git diff',program:'git',args:['--no-pager','-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--',...(files.length?files:['.__mitter_no_readable_files__'])],timeoutMs:20000},root,scratch,signal);
}
