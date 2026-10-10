import {installedMonospaceFonts,type InstalledFont} from './fonts.js';

/** Deliberately expose only the read operation; never accept browser font setters. */
export interface SystemFontListAPI {
 getFontList():Promise<InstalledFont[]>;
}

/**
 * Call only when Use system fonts is enabled (or restored as enabled).
 * Chromium requires fontSettings in permissions, not optional_permissions.
 * Enumeration is local and its results are not persisted or sent to the host.
 */
export async function listSystemMonospaceFonts(api:SystemFontListAPI|undefined,doc:Document=document):Promise<InstalledFont[]>{
 if(!api||typeof api.getFontList!=='function')throw Error('System font discovery is unavailable. Reload the updated Miter extension and check its permissions. Bundled and imported fonts remain available.');
 const fonts=await api.getFontList();
 if(!Array.isArray(fonts))throw Error('Chrome returned an invalid font list. Bundled and imported fonts remain available.');
 return installedMonospaceFonts(fonts,doc);
}
