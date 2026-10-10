import {BUNDLED_FONT} from './appearance.js';
export interface InstalledFont {fontId:string;displayName:string}
export function isMonospaceFont(fontId:string,doc:Document=document):boolean{
 if(!/^[\p{L}\p{N} _.+-]+$/u.test(fontId)||fontId.length>100)return false;
 const ctx=doc.createElement('canvas').getContext('2d');if(!ctx)return false;
 // The caller supplies Chrome's actual installed list. A proportional fallback
 // keeps a disappeared/unloadable family from being mistaken for monospace.
 ctx.font='32px '+JSON.stringify(fontId)+', serif';ctx.fontKerning='none';
 const widths=Array.from(' iWm.@0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',c=>ctx.measureText(c).width);
 return widths.every(w=>w>0&&Math.abs(w-widths[0]!)<0.05);
}
export function installedMonospaceFonts(fonts:InstalledFont[],doc:Document=document):InstalledFont[]{
 const unique=new Map<string,InstalledFont>();
 for(const font of fonts)if(font&&typeof font.fontId==='string'&&font.fontId!==BUNDLED_FONT&&typeof font.displayName==='string'&&isMonospaceFont(font.fontId,doc))unique.set(font.fontId,font);
 return [...unique.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName));
}
