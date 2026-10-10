import { lineDiff } from '../../../../packages/ui/src/line-diff.js';
import type { Store } from './database.js';
import { fileText, validateRelative } from './workspace.js';
export async function reviewFile(store:Store,runId:string,root:string,relative:string){
  validateRelative(relative);
  const change=store.fileChange(runId,relative);
  if(!change)throw new Error('No retained file edits for this path in the current run.');
  let currentHash='missing';
  try{currentHash=(await fileText(root,relative)).hash;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const conflict=currentHash!==change.afterHash;
  return {path:relative,beforeHash:change.beforeHash,afterHash:change.afterHash,currentHash,conflict,status:change.status,
    kind:change.before===null?'created':'modified',diff:lineDiff(change.before??'',change.after),canRestore:!conflict&&change.status==='applied',
    warning:conflict?'The file changed after this recorded edit. Restore is disabled.':undefined};
}
