/** Transport syntax only. Never decode, repair, trim or normalize a quoted
 * JSON string: paths, source, search text and hashes keep every original byte.
 *
 * Rich-text copies can encode INDENTATION as NBSP / whitespace entities and
 * physical line breaks as backslash-newline. These are accepted only outside
 * strings and replaced by JSON whitespace (never joined into a token). Quotes,
 * commas, braces, values, double-encoded entities and prose are not repaired.
 */
export const MAX_HANDOFF_BYTES=400_000;
export const utf8Bytes=(input:string):number=>new TextEncoder().encode(input).length;
/* The handoff limit is measured in UTF-8 bytes (see the model prompt), never in
 * UTF-16 code units, so every reader and the native validator apply the same
 * bound to multibyte replies. */
export const exceedsHandoffBytes=(input:string):boolean=>utf8Bytes(input)>MAX_HANDOFF_BYTES;
export function normalizeReplySyntax(source:string):string {
  const output:string[]=[];
  let quoted=false,escaped=false;
  for(let i=0;i<source.length;i++){
    const c=source[i]!;
    if(quoted){
      output.push(c);
      if(escaped)escaped=false;
      else if(c==='\\')escaped=true;
      else if(c==='"')quoted=false;
      continue;
    }
    if(c==='"'){quoted=true;output.push(c);continue;}
    if(c==='\u00a0'||c==='\u202f'||c==='\ufeff'){output.push(' ');continue;}
    if(c==='&'){
      const entity=/^(?:&nbsp;|&#(?:32|160);|&#x(?:20|a0);)/i.exec(source.slice(i,i+8));
      if(entity){output.push(' ');i+=entity[0].length-1;continue;}
    }
    if(c==='\\'&&(source[i+1]==='\n'||source[i+1]==='\r'&&source[i+2]==='\n')){
      output.push('\n');i+=source[i+1]==='\r'?2:1;continue;
    }
    output.push(c);
  }
  return output.join('');
}

/** Observation only: an open JSON container/string may still be streaming even
 * when a provider does not expose its generation control. This does NOT repair
 * input or grant import authority. Callers may wait a bounded quiet interval;
 * execution must still go through the exact full JSON and schema validators. */
export function isIncompleteReplyJSON(input:string):boolean {
  if(typeof input!=='string'||exceedsHandoffBytes(input))return false;
  let raw=input.trim();
  if(raw.startsWith('```')){
    const start=/^```(?:json)?[ \t]*\r?\n/.exec(raw);if(!start)return false;
    raw=raw.slice(start[0].length).replace(/\r?\n```$/,'');
  }
  raw=normalizeReplySyntax(raw).trim();
  if(!raw.startsWith('{'))return false;
  const stack:string[]=[];let quoted=false,escaped=false;
  for(const c of raw){
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='{'||c==='[')stack.push(c);
    else if(c==='}'||c===']'){
      if(stack.pop()!==(c==='}'?'{':'['))return false;
      if(stack.length===0)return false;
    }
  }
  return stack.length>0;
}

/** Exactly one entire object or one fenced JSON block; no substring search.
 * The same bounded reader is used by DOM discovery, correlation, preview and
 * the native schema validator, so they cannot disagree about syntax recovery.
 */
export function readReplyJSON(input:string):unknown {
  if(typeof input!=='string')throw new Error('The reply must be text. No actions were imported.');
  if(exceedsHandoffBytes(input))throw new Error('Handoff is too large. Split it into smaller batches.');
  let raw=input.trim();
  const fence=/^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw);
  if(fence)raw=fence[1]!;
  try{return JSON.parse(normalizeReplySyntax(raw));}catch(error){
    const position=error instanceof Error?/position (\d+)/.exec(error.message)?.[1]:undefined;
    throw Object.assign(new Error('The reply is not a single valid JSON object'+(position?' (character '+position+')':'')+'. No actions were imported.'),{code:'INVALID_HANDOFF_JSON'});
  }
}

/** Rendered plain-text source is not an acceptable carrier for code changes.
 * A literal, whole, task-linked read request can still make progress; commands,
 * edits, team changes, questions and completion must arrive as fenced code.
 * This is a transport restriction, not an authorization or schema validator.
 */
export function isReadOnlyReply(value:unknown):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const actions=(value as {actions?:unknown}).actions;
  return Array.isArray(actions)&&actions.length>0&&actions.length<=16&&actions.every(a=>
    !!a&&typeof a==='object'&&!Array.isArray(a)&&['read','list','search','diff'].includes(a.type));
}
