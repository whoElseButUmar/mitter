/** Human-operated terminal channel. Deliberately NOT a model Action or a worker RPC. */
export const TERMINAL_CHANNEL = 'miter-terminal/1';
export const TERMINAL_PORT = 'miter-terminal';
export const MAX_INPUT = 16_384;
export interface TerminalInfo {
  id:string; projectId:string; workerId?:string; title:string; cwd:string;
  shell:string; pid:number; cols:number; rows:number; createdAt:number;
  exited:boolean; exitCode?:number; owned:boolean; occupied:boolean; paused:boolean;
}
export interface TerminalFrame { seq:number; data:string }
export interface TerminalRead { frames:TerminalFrame[]; exited:boolean; exitCode?:number; reset:boolean; paused:boolean }
export const TERMINAL_METHODS = new Set(['terminal.list','terminal.create','terminal.attach','terminal.read','terminal.write','terminal.resize','terminal.close','terminal.release','terminal.disconnect']);
export function terminalObject(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid terminal request.');
  return value as Record<string,unknown>;
}
export function terminalFields(value:Record<string,unknown>,allowed:string[]):void {
  if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unexpected terminal request field.');
}
export function terminalId(value:unknown):string {
  if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(value))throw Error('Invalid terminal identifier.');
  return value;
}
export function dimension(value:unknown,min:number,max:number):number {
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw Error('Invalid terminal size.');
  return Number(value);
}
