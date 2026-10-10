// This manifest sandbox has no extension APIs. Project code gets a second opaque origin.
(() => {
 'use strict';
 let used=false;
 addEventListener('message',event=>{
  if(event.source!==parent||used||event.data?.kind!=='miter.preview'||typeof event.data.html!=='string'||event.data.html.length>36000000)return;
  used=true;
  const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';frame.title='Isolated local file preview';
  const policy="default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
  // Install CSP before the document content. No project controls are exposed to the parent.
  frame.srcdoc='<!doctype html><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+event.data.html;
  document.body.replaceChildren(frame);
 });
 parent.postMessage({kind:'miter.preview.ready'},'*');
})();
