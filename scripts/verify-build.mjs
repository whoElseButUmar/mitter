import {verifyBundledFont} from './prepare-font.mjs';
import {checkManifestSecurity} from './check-security-policy.mjs';
import {checkBundleImports} from './check-bundle-imports.mjs';
import {PAGE_CHANNEL,PAGE_READER} from '../dist/packages/bridge/src/page-transport.js';
/** Fail setup before host registration if extension/host/page assets disagree. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
export async function verifyBuild(root){
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const output=path.join(root,'apps/extension/.output/chrome-mv3');
 const manifest=JSON.parse(await readFile(path.join(output,'manifest.json'),'utf8'));
 if(manifest.version!==pkg.version.split('-')[0] || (pkg.version.includes('-')&&manifest.version_name!==pkg.version))throw Error(`Extension ${manifest.version} does not match source ${pkg.version}. Rebuild before registration.`);
 checkManifestSecurity(manifest);
 const identity=JSON.parse(await readFile(path.join(root,'brand/extension-identity.json'),'utf8'));
 if(!manifest.key)throw Error('The stable extension key is missing.');
 const derived=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 if(derived!==identity.extensionId)throw Error('The extension ID changed. Host registration must not use a different origin.');
 for(const name of ['scripting','nativeMessaging','storage','sidePanel'])if(!manifest.permissions?.includes(name))throw Error(`Required permission missing: ${name}`);
 const page=await readFile(path.join(output,'mitter-page.js')),source=await readFile(path.join(root,'apps/extension/public/mitter-page.js'));
 if(!page.equals(source)||!page.includes(Buffer.from(PAGE_CHANNEL))||!page.includes(Buffer.from(PAGE_READER)))throw Error('The packaged chat page bridge is missing or stale. Rebuild the extension.');
 if(!manifest.sandbox?.pages?.includes('preview-sandbox.html'))throw Error('The isolated preview sandbox is missing from the manifest.');
 for(const name of ['preview-sandbox.html','preview-sandbox.js']){const bundled=await readFile(path.join(output,name)),original=await readFile(path.join(root,'apps/extension/public',name));if(!bundled.equals(original))throw Error('The packaged preview sandbox is stale: '+name);}
 for(const name of ['sidepanel.html','workspace.html','file.html','background.js'])if(!(await readFile(path.join(output,name))).length)throw Error(`Empty extension asset: ${name}`);
 const protocol=await import(pathToFileURL(path.join(root,'dist/packages/protocol/src/index.js')).href);
 if(protocol.APP_VERSION!==pkg.version)throw Error('The compiled native host is from a different version.');
 const terminalFont=await verifyBundledFont(output);
 const bundledImports=await checkBundleImports(output);
 return {version:pkg.version,extensionId:derived,terminalFont,bundleModulesChecked:bundledImports.checked,pageSHA256:createHash('sha256').update(page).digest('hex')};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 try{const result=await verifyBuild(root);console.log(`Build verified: Miter ${result.version}; host, extension ID and packaged page bridge match.`);}
 catch(error){console.error('Build verification failed:',error.message);process.exitCode=1;}
}
