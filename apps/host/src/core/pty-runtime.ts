/** Native terminal dependency preflight. The macOS 1.1.0 package may contain a
 * non-executable spawn-helper (microsoft/node-pty#850 and #919). Repair is an
 * INSTALLER operation, never an agent action or a runtime side effect.
 *
 * node-pty v1.1.0/src/utils.ts loads Release, Debug, then the current prebuild;
 * we inspect require.cache AFTER its real loader has selected a binding. Do not
 * guess that the prebuilt helper is in use when a source build won precedence.
 */
import path from 'node:path';
import {createRequire} from 'node:module';
import {constants, promises as fs} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
import type {PtyFactory} from './terminal.js';

const EXPECTED_VERSION='1.1.0';
const MAX_HELPER_BYTES=16*1024*1024;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export class TerminalRuntimeError extends Error {
  constructor(readonly code:string,message:string,options?:ErrorOptions){super(`${code}: ${message}`,options);this.name='TerminalRuntimeError';}
}
const failure=(code:string,message:string)=>new TerminalRuntimeError(code,message);
const modeText=(mode:number)=>(mode&0o777).toString(8).padStart(3,'0');
function inside(parent:string,child:string){const r=path.relative(parent,child);return !!r&&!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);}

/** Exact layouts used by the pinned dependency, including its bundled layout. */
export function terminalBindingCandidates(packageRoot:string,platform:string,arch:string):string[]{
  if(!['darwin','linux','win32'].includes(platform)||!['arm64','x64','ia32','arm'].includes(arch))throw failure('PTY_PLATFORM','Unsupported terminal platform or architecture.');
  return ['build/Release','build/Debug',`prebuilds/${platform}-${arch}`].flatMap(dir=>[
    path.join(packageRoot,dir,'pty.node'),path.join(packageRoot,'lib',dir,'pty.node')
  ]);
}
/** Refuse links within the canonical dependency, rather than chmod-ing whatever
 * an installed helper symlink happens to reference. node_modules' normal pnpm
 * package symlink is resolved once by the loader before this boundary. */
async function regularMember(root:string,file:string){
  if(!inside(root,file))throw failure('PTY_HELPER_PATH','Terminal helper is outside the resolved dependency.');
  let current=root;const parts=path.relative(root,file).split(path.sep);
  for(let i=0;i<parts.length;i++){
    current=path.join(current,parts[i]!);let st;
    try{st=await fs.lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw failure('PTY_HELPER_MISSING',`Missing terminal runtime file: ${path.relative(root,file)}. Reinstall the candidate; do not skip the terminal test.`);throw error;}
    if(st.isSymbolicLink()||(i<parts.length-1?!st.isDirectory():!st.isFile()))throw failure('PTY_HELPER_PATH','Linked or non-regular terminal dependency file. Reinstall from a clean candidate.');
  }
}
function cpuFor(arch:string){if(arch==='arm64')return 0x0100000c;if(arch==='x64')return 0x01000007;throw failure('PTY_ARCH','Unsupported macOS process architecture: '+arch);}
function thinMachExecutable(bytes:Buffer,cpu:number){return bytes.length>=32&&bytes.readUInt32LE(0)===0xfeedfacf&&bytes.readUInt32LE(4)===cpu&&bytes.readUInt32LE(12)===2;}
/** Require a Mach-O executable for this Node process, not a script with a known
 * filename. This is a format check, NOT a code-signature or malware verdict. */
export function isMachExecutable(bytes:Buffer,arch:string):boolean{
  const cpu=cpuFor(arch);if(thinMachExecutable(bytes,cpu))return true;if(bytes.length<8)return false;
  const magic=bytes.readUInt32BE(0),fat64=magic===0xcafebabf;if(magic!==0xcafebabe&&!fat64)return false;
  const count=bytes.readUInt32BE(4),size=fat64?32:20;if(count<1||count>16||8+count*size>bytes.length)return false;
  for(let i=0;i<count;i++){
    const at=8+i*size;if(bytes.readUInt32BE(at)!==cpu)continue;
    const offset=fat64?Number(bytes.readBigUInt64BE(at+8)):bytes.readUInt32BE(at+8);
    const length=fat64?Number(bytes.readBigUInt64BE(at+16)):bytes.readUInt32BE(at+12);
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<8+count*size||length<32||offset+length>bytes.length)return false;
    return thinMachExecutable(bytes.subarray(offset,offset+length),cpu);
  }return false;
}
export interface HelperCheck {
  helper:string;binding:string;modeBefore:string;modeAfter:string;sha256:string;repaired:boolean;
  sharedInode:boolean;architecture:string;
}
/** Narrow exported filesystem operation for installer and regression fixtures.
 * The caller must already have loaded an approved pinned dependency. */
export async function checkDarwinHelper(packageRoot:string,binding:string,options:{arch:string;repair?:boolean}):Promise<HelperCheck>{
  packageRoot=await fs.realpath(packageRoot);binding=path.resolve(binding);
  if(!terminalBindingCandidates(packageRoot,'darwin',options.arch).includes(binding))throw failure('PTY_HELPER_PATH','The loaded native binding has an unrecognized location. Nothing was modified.');
  await regularMember(packageRoot,binding);
  const helper=path.join(path.dirname(binding),'spawn-helper');await regularMember(packageRoot,helper);
  const initial=await fs.lstat(helper);
  if(initial.size<32||initial.size>MAX_HELPER_BYTES)throw failure('PTY_HELPER_FORMAT','Terminal helper has an invalid size. Reinstall the approved dependency.');
  // Only the leaf is opened; parents were checked above. A shared pnpm store
  // inode is readable, but must NEVER be chmod-ed in place.
  const input=await fs.open(helper,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const st=await input.stat();
    if(!st.isFile()||st.ino!==initial.ino||st.dev!==initial.dev||st.size!==initial.size)throw failure('PTY_HELPER_CHANGED','Terminal helper changed during inspection. Nothing was modified.');
    const bytes=await input.readFile();if(bytes.length!==st.size||!isMachExecutable(bytes,options.arch))throw failure('PTY_HELPER_ARCH',`spawn-helper is not a supported macOS ${options.arch} executable. Reinstall with the same Node architecture; no permission repair was attempted.`);
    if(st.mode&0o7000)throw failure('PTY_HELPER_MODE','Terminal helper has unexpected special permission bits. Nothing was modified.');
    const checksum=hash(bytes),result:HelperCheck={helper,binding,modeBefore:modeText(st.mode),modeAfter:modeText(st.mode),sha256:checksum,repaired:false,sharedInode:st.nlink>1,architecture:options.arch};
    try{await fs.access(helper,constants.X_OK);return result;}catch(error){if((error as NodeJS.ErrnoException).code!=='EACCES')throw error;}
    if(st.mode&0o100)throw failure('PTY_HELPER_ACCESS','spawn-helper already has owner execute permission but macOS denies access. Inspect filesystem/ACL/security settings; Miter will not change those settings.');
    if(!options.repair)throw failure('PTY_HELPER_NOT_EXECUTABLE',`node-pty ${EXPECTED_VERSION} spawn-helper is not executable (mode ${modeText(st.mode)}). From the Miter installation folder run: node scripts/prepare-terminal.mjs --repair. Then rerun installation. No terminal was started.`);
    if(typeof process.getuid!=='function'||st.uid!==process.getuid())throw failure('PTY_HELPER_OWNER','spawn-helper is not owned by the current user. Reinstall as your normal user; do not run Miter with sudo.');
    if(st.mode&0o022)throw failure('PTY_HELPER_MODE','spawn-helper is writable by other users. Reinstall the dependency instead of making it executable.');
    const temporary=path.join(path.dirname(helper),`.miter-spawn-helper-${randomUUID()}.tmp`);
    let staged=false;
    try{
      const copy=await fs.open(temporary,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);staged=true;
      try{
        if(process.platform==='darwin'){
          // Apple's cp -p preserves ACLs, flags and extended attributes (including
          // quarantine). Do not silently strip security metadata via a byte-only
          // copy. No shell, PATH lookup or inherited COPYFILE_DISABLE setting.
          await execFileAsync('/bin/cp',['-p',helper,temporary],{timeout:10000,maxBuffer:64*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
          const copied=await fs.lstat(temporary),held=await copy.stat();
          if(!copied.isFile()||copied.isSymbolicLink()||copied.nlink!==1||copied.ino!==held.ino||copied.dev!==held.dev||hash(await copy.readFile())!==checksum)throw failure('PTY_HELPER_CHANGED','Attribute-preserving helper copy changed unexpectedly. Nothing was published.');
        }else await copy.writeFile(bytes); // Unix filesystem fixtures, not a macOS launch.
        await copy.chmod((st.mode&0o777)|0o100);await copy.sync();
      }finally{await copy.close();}
      await regularMember(packageRoot,helper);
      const latest=await fs.lstat(helper);
      if(latest.ino!==st.ino||latest.dev!==st.dev||latest.size!==st.size||latest.mtimeMs!==st.mtimeMs||latest.ctimeMs!==st.ctimeMs||hash(await fs.readFile(helper))!==checksum)throw failure('PTY_HELPER_CHANGED','Terminal helper changed before publication. The repair was cancelled.');
      if(hash(await fs.readFile(temporary))!==checksum)throw failure('PTY_HELPER_CHANGED','Terminal helper copy failed verification. The repair was cancelled.');
      // Replacing only the local directory entry protects the pnpm store and
      // every other installation even if the original was hardlinked.
      await fs.rename(temporary,helper);staged=false;
      const final=await fs.lstat(helper);await fs.access(helper,constants.X_OK);
      if(final.isSymbolicLink()||!final.isFile()||final.nlink!==1||hash(await fs.readFile(helper))!==checksum)throw failure('PTY_HELPER_CHANGED','Repaired helper verification failed. Installation must stop.');
      return {...result,modeAfter:modeText(final.mode),repaired:true};
    }finally{if(staged)await fs.unlink(temporary).catch(()=>{});}
  }finally{await input.close();}
}
export interface NativeTerminalCheck {version:string;platform:string;architecture:string;helper?:HelperCheck;}
export async function prepareNativeTerminal(options:{root?:string;repair?:boolean}={}):Promise<{factory:PtyFactory;check:NativeTerminalCheck}>{
  if(options.repair&&!options.root)throw failure('PTY_REPAIR_SCOPE','Repair requires an explicit installation root.');
  const require=createRequire(options.root?path.join(await fs.realpath(options.root),'package.json'):import.meta.url);
  let entry:string,pkg:{name?:string;version?:string};
  try{entry=require.resolve('node-pty/package.json');pkg=JSON.parse(await fs.readFile(entry,'utf8'));}
  catch(error){throw new TerminalRuntimeError('PTY_NOT_INSTALLED','node-pty is not installed. Finish setup and approve its build before opening a terminal.',{cause:error});}
  if(pkg.name!=='node-pty'||pkg.version!==EXPECTED_VERSION)throw failure('PTY_VERSION',`Expected node-pty ${EXPECTED_VERSION}, found ${pkg.version??'unknown'}. Use the pinned candidate dependencies.`);
  const packageRoot=await fs.realpath(path.dirname(entry));
  if(options.repair){const root=await fs.realpath(options.root!);const modules=path.join(root,'node_modules');
    if(await fs.realpath(modules)!==modules||!inside(modules,packageRoot))throw failure('PTY_REPAIR_SCOPE','Refusing to modify a dependency outside this installation’s local node_modules.');}
  let pty:PtyFactory;
  try{const loaded=require('node-pty');pty=typeof loaded.spawn==='function'?loaded:loaded.default;if(!pty||typeof pty.spawn!=='function')throw Error('Missing native factory');}
  catch(error){throw new TerminalRuntimeError('PTY_BINDING_LOAD',`The node-pty native binding did not load (${process.platform}/${process.arch}, Node ${process.versions.node}). Reinstall/approve its build using this Node version.`,{cause:error});}
  const check:NativeTerminalCheck={version:pkg.version!,platform:process.platform,architecture:process.arch};
  if(process.platform==='darwin'){
    const candidates=terminalBindingCandidates(packageRoot,process.platform,process.arch);
    const loaded=candidates.filter(file=>require.cache[file]);
    if(loaded.length!==1)throw failure('PTY_BINDING_SELECTION','Could not uniquely identify node-pty’s loaded native binding. No helper permissions were changed.');
    if(packageRoot.includes('app.asar')||packageRoot.includes('node_modules.asar'))throw failure('PTY_HELPER_PATH','This source installer does not support an asar path. Extract Miter into an ordinary directory.');
    check.helper=await checkDarwinHelper(packageRoot,loaded[0]!,{arch:process.arch,repair:options.repair});
  }
  return {check,factory:{spawn(shell,args,settings){try{return pty.spawn(shell,args,settings);}catch(error){
    const native=error instanceof Error?error.message:String(error);
    const detail=native.includes('posix_spawnp')?'posix_spawnp failed.':native.replace(/[\r\n\x00-\x1f]/g,' ').slice(0,180);
    const helper=check.helper?` Helper passed inspection (${check.helper.modeAfter}, ${check.architecture}).`:'';
    throw new TerminalRuntimeError('PTY_SPAWN_FAILED',`The local terminal could not start: ${detail}${helper} Run node scripts/terminal-doctor.mjs from the installation folder for a read-only launch diagnostic. No spawn was retried.`,{cause:error});
  }}}};
}
export async function loadPtyRuntime():Promise<PtyFactory>{return (await prepareNativeTerminal()).factory;}
