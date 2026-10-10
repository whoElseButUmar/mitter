import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../../packages/protocol/src/index.js';
let llama:any,model:any,loadedCoder='';
async function propose(prompt:string,settings:Settings):Promise<string> {
  if(!path.isAbsolute(settings.coderModelPath))throw new Error('A local GGUF file is required. No model is downloaded automatically.');
  await fs.access(settings.coderModelPath);
  if(!llama){const name='node-llama-cpp';const lib=await import(name);llama=await lib.getLlama({gpu:settings.gpu==='cpu'?false:'auto'});}
  if(!model||loadedCoder!==settings.coderModelPath){const previous=model;model=undefined;loadedCoder='';await previous?.dispose();model=await llama.loadModel({modelPath:settings.coderModelPath});loadedCoder=settings.coderModelPath;}
  const name='node-llama-cpp';const {LlamaChatSession}=await import(name);
  const context=await model.createContext({contextSize:settings.contextSize});
  let session:any;
  try {
    session=new LlamaChatSession({contextSequence:context.getSequence(),systemPrompt:'You are Mitter’s local coding worker. Produce only the JSON action object requested. Never invent test results.'});
    const grammar=await llama.getGrammarFor('json');
    return await session.prompt(prompt,{grammar,maxTokens:settings.maxTokens,temperature:0.1});
  } finally {try {session?.dispose();} finally {await context.dispose();}}
}
let chain=Promise.resolve();
process.on('message',(m:any)=>{
  chain=chain.then(async()=>{
    try {
      if(!m||typeof m.id!=='string')return;
      if(m.method!=='propose')throw new Error('Unknown model operation.');
      if(typeof m.input!=='string')throw new Error('Model prompt must be text.');
      const result=await propose(m.input,m.settings);
      process.send?.({id:m.id,ok:true,result});
    } catch(error){process.send?.({id:m.id,ok:false,error:error instanceof Error?error.message:String(error)});}
  });
});
process.on('disconnect',()=>process.exit(0));
