import {spawn} from 'node:child_process';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
const allowed=['--build-only','--chromium','--help'];
if(args.some(arg=>!allowed.includes(arg))||new Set(args).size!==args.length){
  console.error('Usage: node scripts/setup.mjs [--build-only] [--chromium]');
  process.exit(1);
}
if(args.includes('--help')){
  console.log('Install dependencies and build Miter. --build-only skips native-host registration; --chromium registers with Chromium.');
  process.exit(0);
}
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<16)){
  console.error('Miter needs Node.js >=22.16.0.');
  process.exit(1);
}
const win=process.platform==='win32';
function run(program,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd:root,stdio:'inherit',shell:win});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(Error(`${program} exited ${code}`)));
  });
}
const pnpm=(...args)=>run(win?'npx.cmd':'npx',['--yes','pnpm@10.11.0',...args]);
try{
  await pnpm('install','--frozen-lockfile');
  // pnpm owns dependency build consent. The user makes any pending selections.
  await pnpm('approve-builds');
  await pnpm('build');
  await run(process.execPath,['scripts/prepare-terminal.mjs','--repair']);
  if(!args.includes('--build-only')){
    await run(process.execPath,['scripts/register-host.mjs',...(args.includes('--chromium')?['--chromium']:[])]);
  }
  console.log('Build ready. Load or reload apps/extension/.output/chrome-mv3 in Chrome. Keep this folder in place after registration.');
}catch(error){
  console.error('Setup stopped:',error.message);
  process.exitCode=1;
}
