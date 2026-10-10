/** Installer-only permission normalization after explicit dependency approval.
 * No recursive chmod, sudo, security-setting changes, shell execution or network.
 */
import path from 'node:path';
import {prepareNativeTerminal} from '../dist/apps/host/src/core/pty-runtime.js';
const args=process.argv.slice(2);
if(args.some(x=>!['--repair','--check'].includes(x))||args.length>1){console.error('Usage: node scripts/prepare-terminal.mjs [--check | --repair]');process.exit(1);}
const root=path.resolve(import.meta.dirname,'..');
try{
  const {check}=await prepareNativeTerminal({root,repair:args.includes('--repair')});
  console.log(`Native terminal preflight: node-pty ${check.version} · ${check.platform}/${check.architecture}`);
  if(check.helper){const h=check.helper;console.log('Selected helper: '+path.relative(root,h.helper));console.log(h.repaired?`Repaired helper execute permission: ${h.modeBefore} → ${h.modeAfter}. Identical bytes; private local copy, pnpm store inode untouched.`:`Helper executable: mode ${h.modeAfter}. No repair needed.`);console.log('Helper SHA-256: '+h.sha256);}
  else console.log('Binding loaded. macOS spawn-helper repair is not applicable on this platform.');
  console.log('The actual PTY launch test is still required; this preflight alone does not prove a working terminal.');
}catch(error){console.error('Native terminal preflight failed:',error.message);if(error.cause instanceof Error)console.error('Underlying error:',error.cause.message.slice(0,1000));process.exitCode=1;}
