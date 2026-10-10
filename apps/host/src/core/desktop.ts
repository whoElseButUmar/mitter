/** Explicit desktop UI operations. Never exposed as model actions. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { canonicalRoot } from './workspace.js';

export interface DesktopCommand { program: string; args: string[] }
export function folderDialogCommands(platform = process.platform): DesktopCommand[] {
  if (platform === 'darwin') return [{program:'/usr/bin/osascript',args:[
    '-e', 'set selectedFolder to choose folder with prompt "Choose a project folder for Miter"',
    '-e', 'return POSIX path of selectedFolder',
  ]}];
  if (platform === 'win32') return [{program:path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:[
    '-NoProfile','-STA','-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Choose a project folder for Miter"; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath) }; $d.Dispose()',
  ]}];
  return [
    {program:'zenity',args:['--file-selection','--directory','--title=Choose a Miter project folder']},
    {program:'kdialog',args:['--getexistingdirectory',process.env.HOME || '/','--title','Choose a Miter project folder']},
  ];
}
export function desktopExec(command: DesktopCommand): Promise<string> {
  return new Promise((resolve,reject)=>execFile(command.program, command.args, {
    encoding:'utf8',timeout:120000,maxBuffer:65536,windowsHide:true,shell:false,
  },(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout)));
}
export async function pickFolder(execute = desktopExec, platform = process.platform): Promise<{root?:string;cancelled:boolean}> {
  for (const cmd of folderDialogCommands(platform)) {
    try {
      const selected=(await execute(cmd)).trim();
      return selected?{root:await canonicalRoot(selected),cancelled:false}:{cancelled:true};
    } catch(error) {
      const e=error as NodeJS.ErrnoException & {stderr?:string;code?:any};
      if(e.code==='ENOENT')continue;
      if(/\(-128\)|user canceled|user cancelled/i.test(e.stderr || '') || (platform!=='darwin'&&Number(e.code)===1)) return {cancelled:true};
      if((e as {killed?:boolean}).killed)throw new Error('Folder picker timed out. Choose again or enter the path manually.');
      throw new Error('Could not open the folder picker. You can enter the path manually. '+(e.stderr || e.message).slice(0,400));
    }
  }
  throw new Error('No folder picker is installed. On Linux use zenity or kdialog, or enter the path manually.');
}
export async function revealProject(root:string):Promise<void> {
  const canonical=await canonicalRoot(root);
  if(canonical!==root)throw new Error('Project root changed. Re-register it.');
  const cmd=process.platform==='darwin'?{program:'/usr/bin/open',args:[root]}:
    process.platform==='win32'?{program:path.win32.join(process.env.SystemRoot || 'C:\\Windows','explorer.exe'),args:[root]}:
    {program:'xdg-open',args:[root]};
  await desktopExec(cmd);
}
