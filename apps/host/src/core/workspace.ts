import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Action, Project, Envelope } from '../../../../packages/protocol/src/index.js';
import { MAX_TEXT } from '../../../../packages/protocol/src/index.js';
import { Store } from './database.js';

import { digest, editContent, planEdits, staleEdit } from './edit-plan.js';
import type { EditStep } from './edit-plan.js';
export { digest } from './edit-plan.js';
const denied = new Set(['.git','.ssh','.aws','.azure','.gnupg','.mitter','.npmrc','.pypirc','.netrc','node_modules','__pycache__','.venv','venv']);
export function validateRelative(input: string, allowRoot = false): string {
  if (input === '.' && allowRoot) return input;
  if (!input || input.length > 1000 || /[\\\0:\x00-\x1f]/.test(input) || input.startsWith('/') || path.win32.isAbsolute(input)) throw new Error('Use a relative project path with forward slashes.');
  const segments = input.split('/');
  if (segments.some(s=>!s || s==='.' || s==='..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s))) throw new Error('Unsafe path segment.');
  if (segments.some(s=>denied.has(s.toLowerCase()) || s.toLowerCase().startsWith('.env') || /\.(pem|key|p12|pfx)$/i.test(s))) throw new Error('Sensitive or excluded path.');
  return input;
}
export async function canonicalRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new Error('Project root must be an absolute path.');
  const root = await fs.realpath(input);
  const home = await fs.realpath(os.homedir());
  if (root === path.parse(root).root || root === home) throw new Error('Select a project folder, not your home folder or a drive root.');
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('Project root is not a folder.');
  return root;
}
export function overlaps(a: string, b: string): boolean {
  const norm=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
  a=norm(a); b=norm(b);
  return a===b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep);
}
/** Reject symlinks along the complete path. This is defense in depth, not an OS sandbox. */
export async function safePath(root: string, relative: string, allowRoot=false): Promise<string> {
  validateRelative(relative,allowRoot);
  if ((await fs.realpath(root)) !== root) throw new Error('Project root changed. Re-register it.');
  let current=root;
  if (relative==='.') return root;
  let missing=false;
  for (const part of relative.split('/')) {
    current=path.join(current,part);
    if (missing) continue;
    try {
      const stat=await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed.');
      if (stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked files are not allowed.');
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Special files are not allowed.');
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') missing=true; else throw error;
    }
  }
  return current;
}
export async function fileText(root:string,relative:string):Promise<{content:string;hash:string}> {
  const target=await safePath(root,relative);
  // O_NOFOLLOW binds the descriptor to the inode that existed at open time, so
  // a symlink swapped in after safePath() cannot be followed. fstat re-verifies
  // the opened inode itself: regular, unlinked, within the size budget.
  const fd=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const stat=await fd.stat();
    if (!stat.isFile() || stat.nlink>1 || stat.size>MAX_TEXT) throw new Error('Read limited to ordinary, unlinked UTF-8 files of at most 120 KB.');
    const bytes=await fd.readFile();
    if (bytes.length>MAX_TEXT) throw new Error('File grew beyond the read limit.');
    if (bytes.includes(0)) throw new Error('Binary files are not supported.');
    const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    return {content,hash:digest(content)};
  } finally { await fd.close(); }
}
export async function existing(root:string,relative:string):Promise<{content:string|null;hash:string}> {
  try { return await fileText(root,relative); }
  catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return {content:null,hash:'missing'}; throw error; }
}
export async function listFiles(root:string,relative='.',max=300):Promise<string[]> {
  const start=await safePath(root,relative,true); const output:string[]=[];
  async function visit(dir:string,depth:number) {
    if (depth>8 || output.length>=max) return;
    const entries=await fs.readdir(dir,{withFileTypes:true});
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries) {
      if(output.length>=max) return;
      const abs=path.join(dir,entry.name),rel=path.relative(root,abs).split(path.sep).join('/');
      try { validateRelative(rel); } catch { continue; }
      if(entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) { if(['dist','build','coverage','.next'].includes(entry.name)) continue; await visit(abs,depth+1); }
      else if(entry.isFile()) output.push(rel);
    }
  }
  await visit(start,0); return output;
}
export async function searchFiles(root:string,query:string):Promise<{path:string;line:number;text:string}[]> {
  const matches:{path:string;line:number;text:string}[]=[];
  for(const relative of await listFiles(root,'.',300)) {
    try {
      const {content}=await fileText(root,relative);
      const lines=content.split('\n');
      for(let i=0;i<lines.length && matches.length<40;i++) if(lines[i]!.includes(query)) matches.push({path:relative,line:i+1,text:lines[i]!.slice(0,300)});
      if(matches.length>=40) break;
    } catch { /* unreadable/binary/oversized files are never fed into a model */ }
  }
  return matches;
}
export async function atomicWrite(root:string,relative:string,content:string,expectedHash?:string):Promise<void> {
  const target=await safePath(root,relative);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await safePath(root,relative);
  let mode=0o600;
  try { mode=(await fs.stat(target)).mode & 0o777; } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const temp=path.join(path.dirname(target),`.mitter-tmp-${randomUUID()}`);
  try {
    const handle=await fs.open(temp,'wx',mode);
    try { await handle.writeFile(content,'utf8'); await handle.sync(); } finally { await handle.close(); }
    await safePath(root,relative);
    if(expectedHash!==undefined) {
      const current=await existing(root,relative);
      if(current.hash!==expectedHash)throw staleEdit(relative,expectedHash,current.hash);
    }
    if(expectedHash==='missing') {
      // Exclusive publication: a concurrently created target must not be replaced.
      try { await fs.link(temp,target); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code==='EEXIST')throw staleEdit(relative,'missing',(await existing(root,relative)).hash);
        throw error;
      }
    } else await fs.rename(temp,target);
  } finally { await fs.unlink(temp).catch(()=>{}); }
}
export class Workspace {
  constructor(readonly store:Store) {}
  async plan(project:Project,workerId:string,runId:string,batch:Envelope,cursor:number) {
    if(batch.projectId!==project.id)throw new Error('Edit batch belongs to another project.');
    // Different spellings of the same existing path (notably on macOS) must
    // not be planned as independent files. No symlink traversal is introduced.
    const names=new Map<string,string>();
    return planEdits(this.store,workerId,runId,batch,cursor,async relative=>{
      const target=await safePath(project.root,relative);
      try {
        const real=await fs.realpath(target),prior=names.get(real);
        if(prior&&prior!==relative)throw new Error(`Use one spelling for the same file: ${prior} and ${relative}.`);
        names.set(real,relative);
      } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return existing(project.root,relative);
    });
  }
  async commitStep(project:Project,workerId:string,runId:string,step:EditStep) {
    if(step.done) {
      // The whole journal chain and its current disk head were proved by plan().
      // A cursor lag after a crash must never replay a superseded earlier write.
      if(step.prior?.status==='prepared')this.markApplied(project,step.id);
      return {path:step.action.path,hash:step.after.hash,alreadyApplied:true,recovered:step.prior?.status==='prepared'};
    }
    return this.write(project,workerId,runId,step.id,{...step.action,expectedHash:step.before.hash});
  }
  private markApplied(project:Project,actionId:string) {
    this.store.transaction(()=>{this.store.markWrite(actionId,'applied');project.revision++;this.store.saveProject(project);});
  }
  async write(project:Project,workerId:string,runId:string,actionId:string,action:Extract<Action,{type:'write'|'replace'}>) {
    const prior=this.store.journal(actionId);
    const current=await existing(project.root,action.path);
    if(prior) {
      if(prior.workerId!==workerId||prior.runId!==runId||prior.path!==action.path||!['applied','prepared'].includes(prior.status))
        throw new Error('An earlier execution of this action is ambiguous. Review the journal; it will not be replayed.');
      const planned=editContent(action,{content:prior.before,hash:prior.beforeHash});
      if(prior.beforeHash!==action.expectedHash||prior.afterHash!==planned.hash||prior.after!==planned.content)
        throw new Error('An earlier execution has different action content. The journal will not be overwritten.');
      if(current.hash===prior.afterHash) {
        if(prior.status==='prepared')this.markApplied(project,actionId);
        return {path:action.path,hash:prior.afterHash,alreadyApplied:true,recovered:prior.status==='prepared'};
      }
      // A crash before publication left an immutable prepared edit, not an
      // ambiguous command. Reapply ONLY when the disk is still the exact before.
      if(prior.status!=='prepared'||current.hash!==prior.beforeHash)
        throw new Error('An earlier execution of this action is ambiguous. Review or roll back; it will not be replayed.');
      await atomicWrite(project.root,action.path,prior.after,prior.beforeHash);
      this.markApplied(project,actionId);
      return {path:action.path,hash:prior.afterHash,bytes:Buffer.byteLength(prior.after),recovered:true};
    }
    if(current.hash!==action.expectedHash)throw staleEdit(action.path,action.expectedHash,current.hash);
    const next=editContent(action,current),content=next.content!;
    this.store.prepareWrite({id:actionId,workerId,runId,path:action.path,before:current.content,after:content,beforeHash:current.hash,afterHash:next.hash,status:'prepared',time:Date.now()});
    await atomicWrite(project.root,action.path,content,current.hash);
    this.markApplied(project,actionId);
    return {path:action.path,hash:next.hash,bytes:Buffer.byteLength(content)};
  }
  async rollback(project:Project,runId:string,relative?:string,expectedHash?:string) {
    if(relative!==undefined){validateRelative(relative);if(expectedHash!==undefined&&(await existing(project.root,relative)).hash!==expectedHash)throw new Error("The file changed after you opened the change review. Reload it before restoring.");}
    const writes=this.store.writes(runId).filter(j=>(j.status==='applied'||j.status==='prepared')&&(relative===undefined||j.path===relative));
    const simulated=new Map<string,string>();
    // Preflight all paths first. Do not clobber edits made after this run.
    for(const j of writes) {
      const current=simulated.get(j.path) ?? (await existing(project.root,j.path)).hash;
      if(current!==j.afterHash && !(j.status==='prepared' && current===j.beforeHash)) throw new Error(`Rollback conflict: ${j.path} has changed outside this run.`);
      simulated.set(j.path,j.beforeHash);
    }
    for(const j of writes) {
      if(j.before===null) {
        const actual=await existing(project.root,j.path);
        if(actual.hash!==j.afterHash&&!(j.status==='prepared'&&actual.hash==='missing'))throw new Error(`Rollback conflict: ${j.path} changed during restoration.`);
        if(actual.hash!=='missing'){const target=await safePath(project.root,j.path);await fs.unlink(target);}
      }
      else await atomicWrite(project.root,j.path,j.before,j.status==='prepared'&&(await existing(project.root,j.path)).hash===j.beforeHash?j.beforeHash:j.afterHash);
      this.store.markWrite(j.id,'rolled_back');
    }
    project.revision++; this.store.saveProject(project);
    return {restored:writes.length,warning:'Only Mitter file edits are restored. Command side effects, databases, and external systems are not rolled back.'};
  }
}
