import {atomicConfig,configTransaction} from './atomic-config.mjs';
import {readFile,mkdir,writeFile,chmod,unlink} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const identity=JSON.parse(await readFile(path.join(root,'brand/extension-identity.json'),'utf8'));
const args=process.argv.slice(2),portable=args.includes('--portable'),remove=args.includes('--remove');
const browser=args.includes('--chromium')?'chromium':'chrome';
const override=args.find(a=>a.startsWith('--manifest-dir='))?.slice('--manifest-dir='.length);
const dataDir=path.resolve(process.env.MITTER_HOME||path.join(os.homedir(),'.mitter'));
const installDir=path.join(dataDir,'native');await mkdir(installDir,{recursive:true,mode:0o700});
const launcher=path.join(installDir,process.platform==='win32'?'mitter-host.cmd':'mitter-host');
const hostScript=path.join(root,'dist/apps/host/src/native.js');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

const manifest={name:identity.nativeHost,description:'Miter local project host',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${identity.extensionId}/`]};
let manifestDir;
if(override)manifestDir=path.resolve(override);
else if(process.platform==='darwin')manifestDir=path.join(os.homedir(),'Library/Application Support',browser==='chrome'?'Google/Chrome':'Chromium','NativeMessagingHosts');
else if(process.platform==='win32')manifestDir=installDir;
else manifestDir=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),browser==='chrome'?'google-chrome':'chromium','NativeMessagingHosts');
await mkdir(manifestDir,{recursive:true});
const manifestPath=path.join(manifestDir,identity.nativeHost+'.json');
await configTransaction([launcher,manifestPath],async()=>{
if(!remove) {
  await readFile(hostScript); // fail before registering a nonexistent build
  if(process.platform==='win32') {
    if(/[\r\n%"]/.test(process.execPath+hostScript+dataDir+root))throw new Error('For Windows registration, use an installation path without %, quotes, or newlines.');
    await atomicConfig(launcher,`@echo off\r\nset "MITTER_HOME=${dataDir}"\r\ncd /d "${root}" || exit /b 1\r\n"${process.execPath}" "${hostScript}" ${portable?'--portable ':''}%*\r\n`,0o700);
  } else {
    await atomicConfig(launcher,`#!/bin/sh\nexport MITTER_HOME=${quote(dataDir)}\ncd ${quote(root)} || exit 1\nexec ${quote(process.execPath)} ${quote(hostScript)} ${portable?'--portable ':''}"$@"\n`,0o700);
  }
}
if(remove)await unlink(manifestPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
else await atomicConfig(manifestPath,JSON.stringify(manifest,null,2)+'\n',0o600);
if(process.platform==='win32'&&!override) {
 const key=`HKCU\\Software\\${browser==='chrome'?'Google\\Chrome':'Chromium'}\\NativeMessagingHosts\\${identity.nativeHost}`;
 const result=spawnSync('reg',remove?['delete',key,'/f']:['add',key,'/ve','/t','REG_SZ','/d',manifestPath,'/f'],{stdio:'inherit',shell:false});
 if(result.error||result.status!==0)throw new Error('Windows native-host registry update failed.');
}
});
console.log(`${remove?'Removed':'Registered'} ${identity.nativeHost} for ${browser}.`);
console.log('Manifest:',manifestPath);console.log('Extension ID:',identity.extensionId);
if(!remove){console.log('Next: Chrome → Extensions → Developer mode → Load unpacked');console.log(path.join(root,'apps/extension/.output/chrome-mv3'));}
