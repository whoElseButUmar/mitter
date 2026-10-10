/** Themes are color data only. No CSS, scripts, URLs or executable packages. */
export const COLOR_KEYS=['foreground','background','cursor','cursorAccent','selectionBackground','selectionForeground','black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'] as const;
export type TerminalColors=Partial<Record<typeof COLOR_KEYS[number],string>>;
export interface TerminalTheme {id:string;name:string;colors:TerminalColors;custom?:boolean}
const palette={black:'#191919',red:'#df7777',green:'#a9c580',yellow:'#ebcc87',blue:'#8aafd1',magenta:'#be9acb',cyan:'#8ebec1',white:'#d5d2c8',brightBlack:'#777772',brightRed:'#ef9696',brightGreen:'#bed99a',brightYellow:'#f4dda5',brightBlue:'#a7c8e7',brightMagenta:'#d2b2dc',brightCyan:'#a8d5d6',brightWhite:'#fffbee'};
export const BUILTIN_THEMES:TerminalTheme[]=[
 {id:'graphite',name:'Miter Graphite',colors:{...palette,background:'#191b1d',foreground:'#dddcd2',cursor:'#e6c88d',cursorAccent:'#191b1d',selectionBackground:'#50534d'}},
 {id:'amber',name:'Classic Amber',colors:{...palette,background:'#18150e',foreground:'#e8bd70',cursor:'#ffcf75',cursorAccent:'#18150e',selectionBackground:'#59462b'}},
 {id:'phosphor',name:'Phosphor',colors:{...palette,background:'#101913',foreground:'#a8d4a2',cursor:'#c6efab',cursorAccent:'#101913',selectionBackground:'#304b35'}},
 {id:'paper',name:'Studio Paper',colors:{...palette,background:'#f3efe4',foreground:'#343631',cursor:'#8a6128',cursorAccent:'#f3efe4',selectionBackground:'#d5c9ae',black:'#232623',white:'#7d786f',brightWhite:'#3c403b',yellow:'#80611e',green:'#356235',cyan:'#276567',blue:'#3c5f93'}},
 {id:'ocean',name:'Night Ocean',colors:{...palette,background:'#13202b',foreground:'#cbd7de',cursor:'#92c6da',cursorAccent:'#13202b',selectionBackground:'#354b60'}}
];
export interface TerminalPreferences {version:1;themeId:string;fontFamily:string;useSystemFonts:boolean;fontSize:number;lineHeight:number;cursorStyle:'block'|'bar'|'underline';cursorBlink:boolean;scrollback:number;customThemes:TerminalTheme[]}
export const BUNDLED_FONT='FiraCode Nerd Font Mono';
export const MAX_FONT_BYTES=4*1024*1024;
export const MAX_IMPORTED_FONT_BYTES=6*1024*1024;
export const DEFAULT_TERMINAL_PREFERENCES:TerminalPreferences={version:1,themeId:'graphite',fontFamily:BUNDLED_FONT,useSystemFonts:false,fontSize:13,lineHeight:1.2,cursorStyle:'block',cursorBlink:true,scrollback:3000,customThemes:[]};
export function parseTheme(raw:unknown,id='custom-'+crypto.randomUUID()):TerminalTheme{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Choose a theme JSON object.');
 const o=raw as Record<string,unknown>;let input:Record<string,unknown>;
 const nested=o.colors??o.theme;
 if(nested!==undefined){if(!nested||typeof nested!=='object'||Array.isArray(nested))throw Error('Invalid theme colors.');input=nested as Record<string,unknown>;if(Object.keys(o).some(k=>!['name','colors','theme','id','custom'].includes(k)))throw Error('Theme contains unsupported fields.');}
 else input=Object.fromEntries(Object.entries(o).filter(([k])=>!['name','id','custom'].includes(k)));
 if(Object.keys(input).some(k=>!COLOR_KEYS.includes(k as any)))throw Error('Themes may contain terminal colors only—not CSS, scripts or URLs.');
 const colors:TerminalColors={};for(const [key,value] of Object.entries(input)){if(typeof value!=='string'||!/^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(value))throw Error('Theme colors must be hexadecimal (#RRGGBB).');colors[key as keyof TerminalColors]=value;}
 if(!colors.background||!colors.foreground)throw Error('The theme needs foreground and background colors.');
 const name=typeof o.name==='string'?o.name.trim():'Imported theme';if(!name||name.length>60||/[\x00-\x1f]/.test(name))throw Error('Invalid theme name.');
 return {id,name,colors,custom:true};
}
export function parsePreferences(raw:unknown):TerminalPreferences{
 const base={...DEFAULT_TERMINAL_PREFERENCES,customThemes:[] as TerminalTheme[]};if(!raw||typeof raw!=='object')return base;
 const o=raw as Partial<TerminalPreferences>;if(o.version!==1)return base;
 if(Array.isArray(o.customThemes))for(const t of o.customThemes.slice(0,20))try{if(typeof t.id==='string'&&/^custom-[A-Za-z0-9_-]+$/.test(t.id))base.customThemes.push(parseTheme(t,t.id));}catch{}
 if(typeof o.themeId==='string'&&[...BUILTIN_THEMES,...base.customThemes].some(t=>t.id===o.themeId))base.themeId=o.themeId;
 if(typeof o.fontFamily==='string'&&o.fontFamily.length<=100&&/^[\p{L}\p{N} _.+-]+$/u.test(o.fontFamily))base.fontFamily=o.fontFamily;
 // Legacy explicit system choices opt in to local discovery; unavailable fonts fall back.
 base.useSystemFonts=typeof o.useSystemFonts==='boolean'?o.useSystemFonts:base.fontFamily!==BUNDLED_FONT&&!base.fontFamily.startsWith('MiterFont_');
 if(!base.useSystemFonts&&!base.fontFamily.startsWith('MiterFont_'))base.fontFamily=BUNDLED_FONT;
 if(typeof o.fontSize==='number'&&Number.isInteger(o.fontSize)&&o.fontSize>=10&&o.fontSize<=28)base.fontSize=o.fontSize;
 if(typeof o.lineHeight==='number'&&o.lineHeight>=1&&o.lineHeight<=1.8)base.lineHeight=o.lineHeight;
 if(['block','bar','underline'].includes(o.cursorStyle||''))base.cursorStyle=o.cursorStyle!;
 if(typeof o.cursorBlink==='boolean')base.cursorBlink=o.cursorBlink;
 if(typeof o.scrollback==='number'&&Number.isInteger(o.scrollback)&&o.scrollback>=500&&o.scrollback<=10000)base.scrollback=o.scrollback;
 return base;
}
export function resolvedTheme(p:TerminalPreferences):TerminalTheme{return [...BUILTIN_THEMES,...p.customThemes].find(t=>t.id===p.themeId)||BUILTIN_THEMES[0]!;}
export function validateFontBytes(bytes:Uint8Array):void{
 if(bytes.length<12||bytes.length>MAX_FONT_BYTES)throw Error('Choose a font no larger than 4 MB.');
 const tag=String.fromCharCode(...bytes.slice(0,4));
 if(!(bytes[0]===0&&bytes[1]===1&&bytes[2]===0&&bytes[3]===0)&&!['OTTO','wOFF','wOF2'].includes(tag))throw Error('Supported font files: TTF, OTF, WOFF, WOFF2.');
}
