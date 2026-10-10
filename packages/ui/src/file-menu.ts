import type { MenuItem } from './menu.js';
export interface FileMenuActions {
 openWindow():void; reveal():void; openEditor():void; copyPath():void;
 copySource():void; reload():void; hasSource:boolean; truncated:boolean;
}
/** Source / Preview already have adjacent buttons. Do not duplicate them here. */
export function fileViewerMenu(a:FileMenuActions):MenuItem[]{return [
 {id:'window',label:'Open in new window',run:a.openWindow},
 {id:'finder',label:'Reveal in file manager',separatorBefore:true,run:a.reveal},
 {id:'vscode',label:'Open in VS Code',run:a.openEditor},
 {id:'copy-path',label:'Copy relative path',separatorBefore:true,run:a.copyPath},
 {id:'copy-source',label:a.truncated?'Copy displayed source':'Copy source',disabled:!a.hasSource,run:a.copySource},
 {id:'reload',label:'Reload file',run:a.reload}
];}
