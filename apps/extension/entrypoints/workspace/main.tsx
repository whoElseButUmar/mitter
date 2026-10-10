import {ResetBoundary} from '../../src/ResetBoundary';
import { render } from 'solid-js/web';
import App from '../../src/App';
import { parseFileTarget,filePreviewURL } from '../../../../packages/ui/src/file-target';
// Legacy file links now open the file-only surface, not another workspace.
if(new URLSearchParams(location.search).has('file')) {
 try { location.replace(filePreviewURL(chrome.runtime.getURL('/file.html'),parseFileTarget(location.href))); }
 catch(error) { document.getElementById('root')!.textContent=error instanceof Error?error.message:String(error); }
} else render(() => <ResetBoundary app={()=><App/>}/>, document.getElementById('root')!);
