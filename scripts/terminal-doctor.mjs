/** Read-only diagnostic: resolves/loads the native binding and inspects selected
 * helper, shell and temp directory. Never starts a shell, chmods or clears xattrs.
 * Paths may be private; review output before sharing. */
import path from 'node:path';import os from 'node:os';
import {promises as fs,constants} from 'node:fs';
import {prepareNativeTerminal} from '../dist/apps/host/src/core/pty-runtime.js';
const root=path.resolve(import.meta.dirname,'..');
if(process.argv.length>2){console.error('Usage: node scripts/terminal-doctor.mjs');process.exit(1);}
const report={node:process.version,platform:process.platform,architecture:process.arch,installation:root,checks:[],modifiedFiles:false,spawnedProcesses:false};
for(const [name,file,mode]of [['temporary-directory',os.tmpdir(),constants.R_OK|constants.W_OK|constants.X_OK],['shell',process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'/bin/sh',constants.X_OK]]){
 try{await fs.access(file,mode);report.checks.push({name,status:'passed',path:await fs.realpath(file)});}catch(e){report.checks.push({name,status:'failed',error:e.message});}
}
try{const {check}=await prepareNativeTerminal({root});report.checks.push({name:'native-terminal-runtime',status:'passed',...check});}
catch(e){report.checks.push({name:'native-terminal-runtime',status:'failed',error:e.message,cause:e.cause instanceof Error?e.cause.message.slice(0,1000):undefined});}
report.guidance='These are prerequisites, not proof of an OS launch. No permissions, quarantine flags or other macOS security settings were changed.';
console.log(JSON.stringify(report,null,2));if(report.checks.some(x=>x.status==='failed'))process.exitCode=1;
