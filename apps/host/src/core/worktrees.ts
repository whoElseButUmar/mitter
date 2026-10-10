import {devNull} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {canonicalRoot} from './workspace.js';
const exec=promisify(execFile);
async function git(root:string,args:string[]){return (await exec('git',['-c','core.hooksPath='+devNull,'-c','core.fsmonitor=false',...args],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:256000,shell:false})).stdout.trim();}
/** An explicit UI-only operation. Never stashes, commits, merges or changes HEAD. */
export async function createWorktree(root:string,stateRoot:string,workerId:string){
  const top=await canonicalRoot(await git(root,['rev-parse','--show-toplevel']));
  if(top!==root)throw new Error('For an isolated worktree, connect the repository root as the project.');
  const baseline=await git(root,['rev-parse','--verify','HEAD']);
  if(await git(root,['status','--porcelain','--untracked-files=normal']))throw new Error('Commit or move your pending changes before making an isolated worktree. Miter never stashes or commits for you.');
  const branch='miter/task-'+workerId,dir=path.join(stateRoot,'worktrees',workerId);
  await fs.mkdir(path.dirname(dir),{recursive:true,mode:0o700});
  await git(root,['worktree','add','-b',branch,'--',dir,baseline]);
  return {root:await canonicalRoot(dir),branch,baseCommit:baseline};
}
