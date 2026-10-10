import {persistLocal} from './data-view';
import {createSignal,createEffect,onMount,onCleanup,For,Show} from 'solid-js';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {TerminalClient} from './terminal-client';
import {SelectSurface} from './controls';
import {Modal} from './components';
import {BUNDLED_FONT,MAX_FONT_BYTES,MAX_IMPORTED_FONT_BYTES,BUILTIN_THEMES,DEFAULT_TERMINAL_PREFERENCES,parsePreferences,parseTheme,resolvedTheme,validateFontBytes,type TerminalPreferences} from '../../../packages/terminal/src/appearance';
import type {InstalledFont} from '../../../packages/terminal/src/fonts';
import {listSystemMonospaceFonts} from '../../../packages/terminal/src/system-fonts';
import type {TerminalInfo,TerminalRead} from '../../../packages/terminal/src/protocol';
import './terminal.css';
interface Screen {info:TerminalInfo;term:Terminal;fit:FitAddon;el:HTMLDivElement;after:number;polling:boolean;tail:Promise<void>;pending:number;failed:boolean;exitShown:boolean;disposables:{dispose():void}[]}
interface SavedFont {family:string;name:string;data:string}
const PREF='miter.terminal.appearance.v1',FONTS='miter.terminal.fonts.v1';
export function TerminalDock(props:{visible:boolean;projectId:string;workerId?:string;projectName:string;close:()=>void}){
 let area!:HTMLDivElement,root!:HTMLElement;
 const [sessions,setSessions]=createSignal<TerminalInfo[]>([]),[selected,setSelected]=createSignal(''),[error,setError]=createSignal(''),[busy,setBusy]=createSignal(false),[appearance,setAppearance]=createSignal(false),[prefs,setPrefs]=createSignal<TerminalPreferences>({...DEFAULT_TERMINAL_PREFERENCES,customThemes:[]}),[fonts,setFonts]=createSignal<SavedFont[]>([]),[ready,setReady]=createSignal(false),[systemFonts,setSystemFonts]=createSignal<InstalledFont[]>([]),[fontBusy,setFontBusy]=createSignal(false);
 const screens=new Map<string,Screen>(),lastByProject=new Map<string,string>(),faces=new Map<string,FontFace>();let fontInstalling=false;let preferenceWrites:Promise<void>=Promise.resolve();let alive=true,timer:ReturnType<typeof setInterval>,listBusy=false;
 const client=new TerminalClient(()=>{for(const s of screens.values()){s.failed=true;s.term.options.disableStdin=true;}setError('Terminal connection closed. Shells cannot survive a host restart. Reopen the drawer to reconnect; input is never replayed.');});
 const scope=()=>sessions().filter(s=>s.projectId===props.projectId);
 const chosen=()=>screens.get(selected());
 const fail=(e:unknown)=>setError(e instanceof Error?e.message:String(e));
 const settings=(p:TerminalPreferences)=>({theme:resolvedTheme(p).colors,fontFamily:JSON.stringify(p.fontFamily)+', '+JSON.stringify(BUNDLED_FONT)+', Menlo, Monaco, Consolas, monospace',fontSize:p.fontSize,lineHeight:p.lineHeight,cursorStyle:p.cursorStyle,cursorBlink:p.cursorBlink,scrollback:p.scrollback});
 const apply=async(next:TerminalPreferences)=>{if(!alive)throw Error('This terminal view has closed.');const p=parsePreferences(next);setPrefs(p);for(const s of screens.values())Object.assign(s.term.options,settings(p));requestAnimationFrame(()=>fit());const write=preferenceWrites.catch(()=>{}).then(()=>persistLocal({[PREF]:p}));preferenceWrites=write;await write;};
 const fit=()=>{const s=chosen();if(s&&!s.failed&&props.visible&&s.el.offsetWidth>0)try{s.fit.fit();}catch{}};
 async function refresh(){if(listBusy||!props.projectId)return;listBusy=true;const projectId=props.projectId;try{const rows=await client.request<TerminalInfo[]>('terminal.list',{projectId});if(alive){setSessions(old=>[...old.filter(s=>s.projectId!==projectId),...rows]);for(const [id,s] of screens)if(s.info.projectId===projectId&&!rows.some(row=>row.id===id)){for(const d of s.disposables)d.dispose();s.term.dispose();s.el.remove();screens.delete(id);if(selected()===id)setSelected('');}}}catch(e){fail(e);}finally{listBusy=false;}}
 const choose=(id:string)=>{const projectId=screens.get(id)?.info.projectId;if(projectId)lastByProject.set(projectId,id);if(projectId===props.projectId)setSelected(id);};
 async function attach(info:TerminalInfo){
   const prior=screens.get(info.id);if(prior&&!prior.failed){choose(info.id);fit();return;}if(prior){for(const d of prior.disposables)d.dispose();prior.term.dispose();prior.el.remove();screens.delete(info.id);}
   await client.request('terminal.attach',{sessionId:info.id});if(!alive)return;
   const term=new Terminal({...settings(prefs()),allowProposedApi:false,allowTransparency:false,convertEol:false,logLevel:'off',windowOptions:{},macOptionIsMeta:true,screenReaderMode:true,
    linkHandler:{activate:(_e,uri)=>{try{const u=new URL(uri);if(!['https:','http:'].includes(u.protocol))throw Error('Only HTTP(S) terminal links can be opened.');if(confirm('Open this terminal link in your browser?\n'+u.href))void chrome.tabs.create({url:u.href});}catch(e){fail(e);}}}});
   const addon=new FitAddon();term.loadAddon(addon);const el=document.createElement('div');el.className='terminal-screen';area.append(el);term.open(el);
   const s:Screen={info,term,fit:addon,el,after:0,polling:false,tail:Promise.resolve(),pending:0,failed:false,exitShown:false,disposables:[]};screens.set(info.id,s);
   // Terminal-originated clipboard queries/changes are disabled. Clipboard use
   // remains an explicit human gesture, not an escape-sequence side effect.
   s.disposables.push(term.parser.registerOscHandler(52,()=>true));
   s.disposables.push(term.onData(data=>{if(s.failed||s.info.exited)return;if(s.pending+data.length>65536){s.failed=true;term.options.disableStdin=true;setError('Terminal input queue is full. Input stopped rather than silently dropping keystrokes.');return;}s.pending+=data.length;s.tail=s.tail.then(async()=>{if(s.failed)return;for(let n=0;n<data.length;){let end=Math.min(n+8192,data.length);if(end<data.length&&/[\uD800-\uDBFF]/.test(data[end-1]!))end--;await client.request('terminal.write',{sessionId:info.id,data:data.slice(n,end)});n=end;}}).catch(e=>{s.failed=true;term.options.disableStdin=true;fail(e);}).finally(()=>{s.pending-=data.length;});}));
   s.disposables.push(term.onResize(size=>{if(s.failed||s.info.exited)return;void client.request('terminal.resize',{sessionId:info.id,cols:Math.max(10,Math.min(500,size.cols)),rows:Math.max(2,Math.min(300,size.rows))}).catch(fail);}));
   // Intercept paste before xterm. Multiline/control-character pastes require
   // confirmation; bracketed-paste encoding remains xterm's responsibility.
   const paste=(e:ClipboardEvent)=>{const text=e.clipboardData?.getData('text/plain');if(text===undefined)return;e.preventDefault();e.stopImmediatePropagation();if(text.length>16384){setError('Paste up to 16 KB at a time.');return;}if(/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(text)&&!confirm('Paste multiple lines or control characters into the real shell? This may execute commands.'))return;term.paste(text);};el.addEventListener('paste',paste,true);s.disposables.push({dispose:()=>el.removeEventListener('paste',paste,true)});
   term.attachCustomKeyEventHandler(e=>{if(e.type==='keydown'&&e.metaKey&&e.key.toLowerCase()==='k'){e.preventDefault();term.clear();return false;}if(e.type==='keydown'&&(e.metaKey||e.ctrlKey&&e.shiftKey)&&e.key.toLowerCase()==='c'&&term.hasSelection()){e.preventDefault();void navigator.clipboard.writeText(term.getSelection()).catch(fail);return false;}return true;});
   choose(info.id);requestAnimationFrame(()=>{fit();term.focus();});void read(s);
 }
 async function read(s:Screen){
   if(s.polling||s.failed||s.exitShown||!alive)return;s.polling=true;
   try{const result=await client.request<TerminalRead>('terminal.read',{sessionId:s.info.id,after:s.after});if(!alive||!screens.has(s.info.id))return;
    if(result.reset){s.term.reset();s.term.writeln('\x1b[33m[Earlier terminal scrollback is no longer available.]\x1b[0m');}
    for(const f of result.frames){if(f.seq<=s.after)continue;await new Promise<void>(resolve=>s.term.write(f.data,resolve));s.after=f.seq;}
    if(result.exited&&!s.exitShown){s.exitShown=true;s.info.exited=true;s.term.options.disableStdin=true;s.term.writeln('\r\n\x1b[90m[Shell exited: '+result.exitCode+']\x1b[0m');void refresh();}
   }catch(e){s.failed=true;s.term.options.disableStdin=true;fail(e);}finally{s.polling=false;}
 }
 async function create(){if(busy()||!props.projectId)return;if(!confirm('Open a real local shell?\n\nIt has your macOS/user permissions, not just access to this project. Commands you type run directly. Terminal contents are not sent to ChatGPT.'))return;
  setBusy(true);setError('');try{const info=await client.request<TerminalInfo>('terminal.create',{projectId:props.projectId,...(props.workerId?{workerId:props.workerId}:{}),cols:80,rows:18,confirm:true});await refresh();await attach(info);}catch(e){fail(e);}finally{setBusy(false);}}
 async function end(){const s=chosen();if(!s||!confirm('Close this shell and its attached terminal session? Running foreground work may stop.'))return;try{await client.request('terminal.close',{sessionId:s.info.id,confirm:true});for(const d of s.disposables)d.dispose();s.term.dispose();s.el.remove();screens.delete(s.info.id);setSelected('');lastByProject.delete(s.info.projectId);await refresh();}catch(e){fail(e);}}
 async function importTheme(file?:File){if(!file)return;try{if(file.size>32768)throw Error('Theme files must be smaller than 32 KB.');if(prefs().customThemes.length>=20)throw Error('Remove a custom theme before adding another.');const theme=parseTheme(JSON.parse(await file.text()));await apply({...prefs(),themeId:theme.id,customThemes:[...prefs().customThemes,theme]});setError('');}catch(e){fail(e);}}
 async function loadFont(f:SavedFont){const bytes=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0));validateFontBytes(bytes);const face=new FontFace(f.family,bytes);await face.load();if(!alive)return;document.fonts.add(face);faces.set(f.family,face);}
 async function importFont(file?:File){
  if(!file||fontInstalling)return;fontInstalling=true;let family='',stored=false;
  try{
   if(file.size>MAX_FONT_BYTES)throw Error('Choose a font no larger than 4 MB.');
   if(fonts().reduce((n,f)=>n+Math.ceil(f.data.length*3/4),0)+file.size>MAX_IMPORTED_FONT_BYTES)throw Error('Imported fonts may use at most 6 MB in total. Remove a font first.');
   if(fonts().length>=2)throw Error('Remove an imported font before adding another (maximum 2).');
   const bytes=new Uint8Array(await file.arrayBuffer());validateFontBytes(bytes);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   const f:SavedFont={family:'MiterFont_'+crypto.randomUUID().replaceAll('-',''),name:file.name.slice(0,80),data:btoa(binary)};family=f.family;await loadFont(f);if(!alive)return;
   const next=[...fonts(),f];await persistLocal({[FONTS]:next});stored=true;setFonts(next);await apply({...prefs(),fontFamily:f.family});setError('');
  }catch(e){if(family&&!stored){const face=faces.get(family);if(face)document.fonts.delete(face);faces.delete(family);}fail(e);}finally{fontInstalling=false;}
 }
 async function removeFont(){const family=prefs().fontFamily,face=faces.get(family);await apply({...prefs(),fontFamily:BUNDLED_FONT});const next=fonts().filter(f=>f.family!==family);await persistLocal({[FONTS]:next});setFonts(next);if(face){document.fonts.delete(face);faces.delete(family);}}
 async function loadBundledFont(){
  const face=new FontFace(BUNDLED_FONT,'url('+JSON.stringify(chrome.runtime.getURL('fonts/FiraCodeNerdFontMono-Regular.ttf'))+')',{weight:'400',style:'normal'});
  await face.load();if(!alive)return;document.fonts.add(face);faces.set(BUNDLED_FONT,face);
 }
 async function listSystemFonts():Promise<InstalledFont[]>{
  return listSystemMonospaceFonts(chrome.fontSettings);
 }
 async function useSystemFonts(enabled:boolean){
  if(fontBusy())return;setFontBusy(true);
  try{
   if(!enabled){setSystemFonts([]);await apply({...prefs(),useSystemFonts:false});return;}
   // Chrome requires fontSettings at installation. The checkbox gates local
   // enumeration, not a runtime permission prompt. Never change browser fonts.
   const available=await listSystemFonts();if(!alive)return;setSystemFonts(available);await apply({...prefs(),useSystemFonts:true});setError('');
  }catch(e){fail(e);}finally{setFontBusy(false);}
 }
 onMount(()=>{void (async()=>{
  try{await loadBundledFont();}catch{fail(Error('The bundled FiraCode Nerd Font Mono could not load. A safe monospace fallback is active. Rebuild the extension with prepare:font to restore it.'));}
  const data=await chrome.storage.local.get([PREF,FONTS]);if(!alive)return;
  let p=parsePreferences(data[PREF]);const saved=Array.isArray(data[FONTS])?data[FONTS].slice(0,2):[];const valid:SavedFont[]=[];let importedBytes=0;
  for(const f of saved)try{
   if(!f||typeof f.data!=='string'||f.data.length>Math.ceil(MAX_FONT_BYTES/3)*4||!/^MiterFont_[a-f0-9]+$/.test(f.family)||typeof f.name!=='string'||f.name.length>80)continue;
   const count=Math.ceil(f.data.length*3/4);if(importedBytes+count>MAX_IMPORTED_FONT_BYTES)continue;await loadFont(f);importedBytes+=count;valid.push(f);
  }catch(error){console.warn('Miter saved font could not be restored.',error);}
  if(!alive)return;setFonts(valid);
  if(p.fontFamily.startsWith('MiterFont_')&&!valid.some(f=>f.family===p.fontFamily))p={...p,fontFamily:BUNDLED_FONT};
  if(p.useSystemFonts){
   try{
    const available=await listSystemFonts();if(!alive)return;setSystemFonts(available);
    if(p.fontFamily!==BUNDLED_FONT&&!valid.some(f=>f.family===p.fontFamily)&&!available.some(f=>f.fontId===p.fontFamily)){
     fail(Error('The selected system font is missing. FiraCode Nerd Font Mono is being used instead.'));p={...p,fontFamily:BUNDLED_FONT};
    }
   }catch(e){fail(e);p=parsePreferences({...p,useSystemFonts:false});}
  }
  if(alive){setPrefs(p);setReady(true);}
 })().catch(e=>{if(alive){fail(e);setReady(true);}});
  const resize=new ResizeObserver(()=>fit());resize.observe(root);
  timer=setInterval(()=>{for(const s of screens.values())void read(s);},80);
  onCleanup(()=>{resize.disconnect();clearInterval(timer);});
 });
 createEffect(()=>{if(ready()&&props.visible&&props.projectId){void refresh();const id=lastByProject.get(props.projectId)||'';setSelected(id);requestAnimationFrame(()=>fit());}});
 createEffect(()=>{const id=selected();for(const [key,s] of screens)s.el.hidden=key!==id;requestAnimationFrame(()=>fit());});
 onCleanup(()=>{alive=false;for(const s of screens.values()){for(const d of s.disposables)d.dispose();s.term.dispose();}screens.clear();client.close();for(const face of faces.values())document.fonts.delete(face);});
 return <section ref={root} class="terminal-dock" hidden={!props.visible} aria-label="Local terminal">
  <div class="terminal-toolbar"><strong>Terminal</strong><small title="Project or task worktree used when the shell starts">{props.projectName||'Choose a project'}</small><div class="spacer"/><button disabled={!props.projectId||busy()||!ready()} onClick={()=>void create()} title="New shell">+<span class="wide-label"> New shell</span></button><button onClick={()=>setAppearance(true)} title="Themes and fonts">Appearance…</button><button class="icon-button" onClick={props.close} title="Hide terminal (keep shells running)" aria-label="Hide terminal">×</button></div>
  <Show when={error()}><div class="terminal-error" role="alert">{error()}<button onClick={()=>{setError('');void refresh();}}>Refresh sessions</button></div></Show>
  <div class="terminal-session-row" role="tablist" aria-label="Project terminals"><For each={scope()}>{s=><button role="tab" aria-selected={selected()===s.id} disabled={s.occupied} title={s.occupied?'In use by another view':s.cwd} onClick={()=>void attach(s).catch(fail)}>{s.title}{s.exited?' · exited':''}</button>}</For><Show when={selected()}><div class="spacer"/><button class="text-button" onClick={()=>{const s=chosen();if(s){s.term.clear();s.term.focus();}}}>Clear</button><button class="text-button" onClick={()=>void end()}>Close shell</button></Show></div>
  <div class="terminal-viewport" ref={area}/><Show when={!selected()}><div class="terminal-empty"><strong>Your shell. Your Mac.</strong><p>Open a shell in this project. Its input and output stay separate from ChatGPT and task reports.</p><button disabled={!props.projectId||busy()||!ready()} onClick={()=>void create()} class="primary">Open terminal</button></div></Show>
  <div class="terminal-status"><span>Local shell · user permissions</span><span>Sessions last while the local host is running</span></div>
  <Show when={appearance()}><Modal title="Terminal appearance" close={()=>setAppearance(false)}><SelectSurface>
   <label class="field"><span>Theme</span><select value={prefs().themeId} onChange={e=>void apply({...prefs(),themeId:e.currentTarget.value}).catch(fail)}><For each={[...BUILTIN_THEMES,...prefs().customThemes]}>{t=><option value={t.id}>{t.name}</option>}</For></select></label>
   <div class="terminal-theme-preview" style={{background:resolvedTheme(prefs()).colors.background,color:resolvedTheme(prefs()).colors.foreground,'font-family':settings(prefs()).fontFamily}}><span style={{color:resolvedTheme(prefs()).colors.green}}>~/Projects</span> <span style={{color:resolvedTheme(prefs()).colors.cursor}}>❯</span> your next idea<br/><span style={{color:resolvedTheme(prefs()).colors.brightBlack}}>Aa Bb 0123456789 — preview, not shell output</span></div>
   <div class="button-row"><label class="file-import">Install theme…<input type="file" accept=".json,application/json" onChange={e=>{void importTheme(e.currentTarget.files?.[0]);e.currentTarget.value='';}}/></label><Show when={prefs().themeId.startsWith('custom-')}><button onClick={()=>void apply({...prefs(),themeId:'graphite',customThemes:prefs().customThemes.filter(t=>t.id!==prefs().themeId)}).catch(fail)}>Remove theme</button></Show></div>
   <label class="field"><span>Font</span><select value={prefs().fontFamily} onChange={e=>void apply({...prefs(),fontFamily:e.currentTarget.value}).catch(fail)}><option value={BUNDLED_FONT}>{BUNDLED_FONT}</option><Show when={prefs().useSystemFonts}><For each={systemFonts()}>{f=><option value={f.fontId}>{f.displayName}</option>}</For></Show><For each={fonts()}>{f=><option value={f.family}>{f.name}</option>}</For></select></label>
   <label class="checkline"><input type="checkbox" checked={prefs().useSystemFonts} disabled={fontBusy()||!ready()} onChange={e=>{const enabled=e.currentTarget.checked;e.currentTarget.checked=prefs().useSystemFonts;void useSystemFonts(enabled);}}/><span>Use system fonts</span></label>
   <p class="muted small">Off: bundled and imported fonts only. On: also show installed monospace fonts. Missing fonts fall back safely. Chrome grants font access when Miter is installed. This switch controls local font discovery; Miter never changes Chrome’s font settings or uploads the font list.</p>
   <div class="button-row"><label class="file-import">Install font…<input type="file" accept=".ttf,.otf,.woff,.woff2" onChange={e=>{void importFont(e.currentTarget.files?.[0]);e.currentTarget.value='';}}/></label><Show when={fonts().some(f=>f.family===prefs().fontFamily)}><button onClick={()=>void removeFont().catch(fail)}>Remove font</button></Show></div>
   <div class="terminal-settings-grid"><label class="field"><span>Size</span><input type="number" min="10" max="28" value={prefs().fontSize} onChange={e=>void apply({...prefs(),fontSize:Number(e.currentTarget.value)}).catch(fail)}/></label><label class="field"><span>Line height</span><input type="number" min="1" max="1.8" step="0.1" value={prefs().lineHeight} onChange={e=>void apply({...prefs(),lineHeight:Number(e.currentTarget.value)}).catch(fail)}/></label><label class="field"><span>Cursor</span><select value={prefs().cursorStyle} onChange={e=>void apply({...prefs(),cursorStyle:e.currentTarget.value as TerminalPreferences['cursorStyle']}).catch(fail)}><option value="block">Block</option><option value="bar">Bar</option><option value="underline">Underline</option></select></label></div>
   <label class="checkline"><input type="checkbox" checked={prefs().cursorBlink} onChange={e=>void apply({...prefs(),cursorBlink:e.currentTarget.checked}).catch(fail)}/><span>Blink cursor</span></label><label class="field"><span>Scrollback lines</span><input type="number" min="500" max="10000" step="500" value={prefs().scrollback} onChange={e=>void apply({...prefs(),scrollback:Number(e.currentTarget.value)}).catch(fail)}/></label><p class="muted small">Themes are local JSON color files. Fonts are stored only inside this extension; none are uploaded.</p>
   <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="button-row end"><button onClick={()=>void apply({...DEFAULT_TERMINAL_PREFERENCES,customThemes:prefs().customThemes}).catch(fail)}>Reset appearance</button><button class="primary" onClick={()=>setAppearance(false)}>Done</button></div>
  </SelectSurface></Modal></Show>
 </section>;
}
