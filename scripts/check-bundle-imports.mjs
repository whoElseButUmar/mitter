import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {moduleReferences,isFrameworkSpecifier} from './module-imports.mjs';

/** Extension pages have no external package loader. Refuse an output that
 * "fixes" resolution by leaving Solid/WXT imports for the browser to load. */
export async function checkBundleImports(output) {
  const failures=[];let checked=0;
  async function walk(directory) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){await walk(file);continue;}
      if(!/\.[cm]?js$/.test(file))continue;
      const text=await readFile(file,'utf8');checked++;
      for(const ref of moduleReferences(text,file))if(!ref.typeOnly&&isFrameworkSpecifier(ref.specifier))failures.push(`${path.relative(output,file)}:${ref.line}: unbundled ${ref.specifier}`);
    }
  }
  await walk(output);
  if(failures.length)throw new Error('Unbundled framework dependency in extension output:\n'+failures.join('\n'));
  return {checked};
}
