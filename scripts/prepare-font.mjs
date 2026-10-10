/** Provision exactly one upstream font into the user's locally built extension.
 * Source archives contain no font binary. No system font installation occurs.
 * Downloads are data, never executable code, and never run inside the extension.
 */
import path from 'node:path';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const FONT_FILE='FiraCodeNerdFontMono-Regular.ttf';
export const FONT_URL='https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/FiraCode/Regular/'+FONT_FILE;
export const LICENSE_URL='https://raw.githubusercontent.com/tonsky/FiraCode/6.2/LICENSE';
const maxBytes=4*1024*1024;
function names(buffer){
 const b=Buffer.from(buffer);
 if(b.length<12||b.length>maxBytes||b.readUInt32BE(0)!==0x00010000)throw Error('Expected a TTF font no larger than 4 MB.');
 const count=b.readUInt16BE(4);if(count>256||12+count*16>b.length)throw Error('Invalid TTF directory.');
 let offset=0,length=0;
 for(let i=0;i<count;i++){const p=12+i*16;if(b.toString('ascii',p,p+4)==='name'){offset=b.readUInt32BE(p+8);length=b.readUInt32BE(p+12);}}
 if(!offset||length<6||offset+length>b.length)throw Error('Font has no valid name table.');
 const total=b.readUInt16BE(offset+2),strings=offset+b.readUInt16BE(offset+4),result=new Map();
 if(offset+6+total*12>offset+length||strings>offset+length)throw Error('Invalid font name records.');
 for(let i=0;i<total;i++){
  const p=offset+6+i*12,platform=b.readUInt16BE(p),id=b.readUInt16BE(p+6),size=b.readUInt16BE(p+8),start=strings+b.readUInt16BE(p+10);
  if(start<strings||start+size>offset+length)throw Error('Invalid font name string.');
  let text='';if(platform===0||platform===3){if(size%2)throw Error('Invalid UTF-16 font name.');for(let n=0;n<size;n+=2)text+=String.fromCharCode(b.readUInt16BE(start+n));}else if(platform===1)text=b.toString('latin1',start,start+size);else continue;
  const values=result.get(id)||[];values.push(text);result.set(id,values);
 }
 return result;
}
export function validateBundledFont(buffer){
 const fields=names(buffer);
 if(![...(fields.get(1)||[]),...(fields.get(16)||[])].includes('FiraCode Nerd Font Mono')||!(fields.get(2)||[]).includes('Regular')||!(fields.get(6)||[]).includes('FiraCodeNFM-Reg'))
  throw Error('Use the actual FiraCodeNerdFontMono-Regular.ttf. The non-Mono FiraCodeNerdFont-Regular.ttf is a different face and must not be renamed.');
 return {family:'FiraCode Nerd Font Mono',style:'Regular',sha256:createHash('sha256').update(buffer).digest('hex'),copyright:[...new Set(fields.get(0)||[])].join('\n')};
}
async function download(url,max,fetcher){
 const response=await fetcher(url,{signal:AbortSignal.timeout(90000),redirect:'error'});
 if(!response.ok)throw Error('Download failed ('+response.status+'): '+url);
 if(Number(response.headers.get('content-length')||0)>max)throw Error('Download exceeds its size limit.');
 if(!response.body)throw Error('Empty download.');
 const chunks=[];let bytes=0;
 for await(const chunk of response.body){bytes+=chunk.length;if(bytes>max)throw Error('Download exceeds its size limit.');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
export async function prepareFont({root=path.resolve(import.meta.dirname,'..'),file,licenseFile,fetcher=fetch}={}){
 const directory=path.join(root,'apps/extension/.output/chrome-mv3/fonts');
 // Preserve offline repeat builds by explicitly supplying a local file. A failed
 // download never pretends a fallback is the requested bundled default.
 const bytes=file?await readFile(path.resolve(file)):await download(FONT_URL,maxBytes,fetcher);
 const metadata=validateBundledFont(bytes);
 const license=licenseFile?await readFile(path.resolve(licenseFile)):await download(LICENSE_URL,32768,fetcher);
 if(!license.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')||!license.toString('utf8').includes('Copyright'))throw Error('The font license is missing or invalid.');
 if(process.env.MITER_FONT_SHA256&&process.env.MITER_FONT_SHA256.toLowerCase()!==metadata.sha256)throw Error('The font does not match MITER_FONT_SHA256.');
 await mkdir(directory,{recursive:true});
 const temporary=path.join(directory,FONT_FILE+'.partial');
 try{
  await writeFile(temporary,bytes,{mode:0o644});await rename(temporary,path.join(directory,FONT_FILE));
  await writeFile(path.join(directory,'OFL.txt'),license);
  await writeFile(path.join(directory,'FONT-SOURCE.json'),JSON.stringify({file:FONT_FILE,source:FONT_URL,nerdFonts:'v3.4.0',firaCode:'6.2',...metadata},null,2)+'\n');
 }finally{await rm(temporary,{force:true});}
 return metadata;
}
export async function verifyBundledFont(output){
 const directory=path.join(output,'fonts');
 const result=validateBundledFont(await readFile(path.join(directory,FONT_FILE)));
 const recorded=JSON.parse(await readFile(path.join(directory,'FONT-SOURCE.json'),'utf8'));
 if(recorded.sha256!==result.sha256||recorded.family!==result.family||recorded.file!==FONT_FILE)throw Error('Bundled font identity/hash verification failed.');
 if(!(await readFile(path.join(directory,'OFL.txt'),'utf8')).includes('SIL OPEN FONT LICENSE Version 1.1'))throw Error('Bundled font license is missing.');
 return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const value=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
 try{const result=await prepareFont({file:value('file')||process.env.MITER_FONT_FILE,licenseFile:value('license')||process.env.MITER_FONT_LICENSE});console.log('Prepared one local terminal font: '+result.family+' ('+result.sha256+').');}
 catch(error){console.error('Font provisioning failed: '+error.message+'\nFor an offline build, set MITER_FONT_FILE to the exact Mono-Regular TTF and MITER_FONT_LICENSE to its SIL OFL text file, then rebuild.');process.exitCode=1;}
}
