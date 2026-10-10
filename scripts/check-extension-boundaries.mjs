import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {moduleReferences,isFrameworkSpecifier} from './module-imports.mjs';

export async function checkExtensionBoundaries(root) {
  const config=await readFile(path.join(root,'apps/extension/wxt.config.ts'),'utf8');
  const background=await readFile(path.join(root,'apps/extension/entrypoints/background.ts'),'utf8');
  const failures=[];
  const extension=JSON.parse(await readFile(path.join(root,'apps/extension/package.json'),'utf8'));
  if(extension.dependencies?.['@wxt-dev/module-solid']||extension.devDependencies?.['@wxt-dev/module-solid'])failures.push('Use the direct Solid Vite compiler, not the wrapper with a dependency postinstall.');
  if(!extension.devDependencies?.['vite-plugin-solid']||!/^\d+\.\d+\.\d+$/.test(extension.devDependencies['vite-plugin-solid']))failures.push('Pin the direct Solid Vite compiler exactly.');
  if(!/from\s+['"]vite-plugin-solid['"]/.test(config)||!/plugins\s*:\s*\[\s*solid\(\)\s*\]/.test(config))failures.push('The direct Solid Vite compiler must be registered, not merely declared.');
  if(!/\bimports\s*:\s*false\b/.test(config))failures.push('WXT auto-imports must stay disabled.');
  if(!/from\s+['"]wxt\/utils\/define-background['"]/.test(background))failures.push('background.ts must import defineBackground explicitly.');
  if(!/['"]config:resolved['"]/.test(config)||!config.includes('enforceExplicitImportPolicy(wxt.config.imports)'))failures.push('The final resolved auto-import catalog must be cleared after framework modules.');
  if(!/dedupe\s*:\s*\[\s*['"]solid-js['"]/.test(config))failures.push('Use a single Solid runtime for the extension.');
  let checked=0;
  async function walk(directory) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){if(entry.name!=='node_modules')await walk(file);continue;}
      if(!/\.[cm]?[jt]sx?$/.test(file))continue;
      const source=await readFile(file,'utf8');checked++;
      for(const ref of moduleReferences(source,file))if(isFrameworkSpecifier(ref.specifier))failures.push(`${path.relative(root,file)}:${ref.line} must stay framework-independent; found ${ref.specifier}.`);
    }
  }
  for(const name of ['ui','bridge','protocol','terminal'])await walk(path.join(root,'packages',name,'src'));
  if(failures.length)throw new Error('Extension source-boundary check failed:\n- '+failures.join('\n- '));
  return {checked};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  try{const result=await checkExtensionBoundaries(root);console.log(`Extension source-boundary check passed: ${result.checked} shared modules; final auto-import policy configured.`);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
