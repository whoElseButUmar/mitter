/** Static permission/CSP regression policy. This is not a vulnerability scanner
 * or an independent security audit. It prevents accidentally broadening the
 * existing extension boundary in the built manifest or source configuration. */
import path from 'node:path';import {readFile,readdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
const required=['nativeMessaging','sidePanel','storage','clipboardWrite','scripting','fontSettings'];
const optional=['clipboardRead','notifications'];
const origins=['https://chatgpt.com/*','https://chat.openai.com/*'];
function arrayOnly(actual,allowed,label){if(!Array.isArray(actual)||actual.some(x=>typeof x!=='string'||!allowed.includes(x))||new Set(actual).size!==actual.length)throw Error('Unexpected '+label+'. Review any permission expansion explicitly.');}
export function checkManifestSecurity(manifest){
 // A permissive type assertion cannot change Chromium's manifest rules. Run
 // this for both the source declaration and the generated extension manifest.
 if(Array.isArray(manifest.optional_permissions)&&manifest.optional_permissions.includes('fontSettings'))throw Error('fontSettings cannot be optional in Chrome. Declare it in permissions; the system-font toggle is an application preference.');
 arrayOnly(manifest.permissions,required,'permissions');for(const p of required)if(!manifest.permissions.includes(p))throw Error('Missing required permission: '+p);
 arrayOnly(manifest.optional_permissions??[],optional,'optional permissions');arrayOnly(manifest.optional_host_permissions??[],origins,'optional website access');
 for(const p of optional)if(!manifest.optional_permissions?.includes(p))throw Error('Missing optional permission: '+p);
 for(const origin of origins)if(!manifest.optional_host_permissions?.includes(origin))throw Error('Missing optional website access: '+origin);
 if(manifest.host_permissions?.length||manifest.externally_connectable||manifest.content_scripts?.length)throw Error('Persistent site injection, required host access, or external messaging is not approved.');
 if(!manifest.sandbox?.pages?.includes('preview-sandbox.html'))throw Error('The preview sandbox must remain isolated.');
 const csp=manifest.content_security_policy?.extension_pages;
 if(typeof csp!=='string')throw Error('Missing extension CSP.');
 const directives=new Map();for(const rule of csp.split(';').map(x=>x.trim()).filter(Boolean)){const [name,...values]=rule.split(/\s+/);if(directives.has(name))throw Error('Duplicate CSP directive: '+name);directives.set(name,values);}
 for(const [name,values]of [['script-src',["'self'"]],['object-src',["'none'"]]])if(JSON.stringify(directives.get(name))!==JSON.stringify(values))throw Error('Unsafe '+name+' policy.');
 for(const name of ['frame-src','connect-src'])if(!directives.get(name)||directives.get(name).some(v=>!["'self'",'blob:'].includes(v)))throw Error('Unsafe '+name+' policy.');
 if(!manifest.content_security_policy?.sandbox?.startsWith('sandbox allow-scripts;'))throw Error('Unexpected preview sandbox privileges.');
 return {permissions:manifest.permissions.length,optionalPermissions:(manifest.optional_permissions??[]).length,websiteAccess:'optional',remoteExtensionCode:false};
}
export async function sourceManifest(root){
 const {default:ts}=await import(process.env.MITTER_TYPESCRIPT_MODULE||'typescript');
 const text=await readFile(path.join(root,'apps/extension/wxt.config.ts'),'utf8'),file=ts.createSourceFile('wxt.config.ts',text,ts.ScriptTarget.Latest,true),candidates=[];
 function visit(n){if(ts.isPropertyAssignment(n)&&(n.name.text??'')==='manifest')candidates.push(n.initializer);ts.forEachChild(n,visit);}visit(file);
 if(candidates.length!==1)throw Error('Cannot identify a unique literal extension manifest.');
 function literal(n){if(ts.isAsExpression(n)||ts.isTypeAssertionExpression(n)||ts.isSatisfiesExpression(n)||ts.isParenthesizedExpression(n))return literal(n.expression);if(ts.isStringLiteral(n)||ts.isNumericLiteral(n))return ts.isNumericLiteral(n)?Number(n.text):n.text;if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);if(ts.isObjectLiteralExpression(n)){const value={};for(const p of n.properties){if(!ts.isPropertyAssignment(p)||typeof p.name.text!=='string')throw Error('Dynamic manifest fields need explicit security review.');if(Object.hasOwn(value,p.name.text))throw Error('Duplicate manifest field.');value[p.name.text]=literal(p.initializer);}return value;}throw Error('Nonliteral manifest field cannot pass the static permission check.');}
 return literal(candidates[0]);
}
export async function checkSecurityPolicy(root){
 const result=checkManifestSecurity(await sourceManifest(root));let pages=0;
 for(const name of await readdir(path.join(root,'apps/extension/public'))){if(!name.endsWith('.html'))continue;const text=await readFile(path.join(root,'apps/extension/public',name),'utf8');pages++;for(const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)){if(/^(?:[a-z]+:|\/\/)/i.test(match[1]))throw Error('Remote script in extension page: '+name);}}
 return {...result,staticPagesChecked:pages};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{console.log('Security policy passed:',await checkSecurityPolicy(path.resolve(import.meta.dirname,'..')));}catch(e){console.error(e.message);process.exitCode=1;}
