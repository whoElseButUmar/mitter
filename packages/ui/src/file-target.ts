/** A file window is a read-only, task-scoped viewer, never the workspace app. */
export interface FileTarget { workerId:string; path:string }
export function validateFileTarget(target:FileTarget):FileTarget {
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(target.workerId))throw new Error('Invalid file task.');
 const path=target.path;
 if(typeof path!=='string'||!path||path.length>1000||/[\\\u0000-\u001f]/.test(path)||path.startsWith('/')||/^[a-zA-Z]:/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Choose a project-relative file.');
 return {workerId:target.workerId,path};
}
export function filePreviewURL(base:string,target:FileTarget):string {
 const checked=validateFileTarget(target),url=new URL(base);
 url.search='';url.hash='';url.searchParams.set('task',checked.workerId);url.searchParams.set('file',checked.path);return url.href;
}
export function parseFileTarget(url:string):FileTarget {
 const query=new URL(url).searchParams;
 if(query.getAll('task').length!==1||query.getAll('file').length!==1)throw new Error('The file link is incomplete. Open the file again from Miter.');
 return validateFileTarget({workerId:query.get('task')!,path:query.get('file')!});
}
export function fileWindowOptions(url:string):{url:string;type:'popup';focused:boolean;width:number;height:number;setSelfAsOpener:boolean} {
 return {url,type:'popup',focused:true,width:1080,height:760,setSelfAsOpener:false};
}
