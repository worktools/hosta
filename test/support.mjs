import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
export const root=resolve(import.meta.dirname,'..');
export async function startProcess(command,args,env={}) {
  const child=spawn(command,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='';
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Startup deadline exceeded: '+output));},10000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+output));});
    const read=chunk=>{output+=chunk;const match=output.match(/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};
    child.stdout.on('data',read);child.stderr.on('data',read);
  });
  return {url,child,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}};
}
export async function hosta(engineUrl,extra={}) {
  const dir=await mkdtemp(join(tmpdir(),'hosta-test-'));
  const process=await startProcess(globalThis.process.execPath,['dist/index.js'],{PORT:'0',HOSTA_DATA_FILE:join(dir,'hosta.json'),DEEPSEEK_API_KEY:'',HOYA_URL:engineUrl,HOYA_AUTH_TOKEN:'test-engine',HOSTA_API_TOKEN:'test-management',HOSTA_ENABLE_LOCAL_COMPILER:'',...extra});
  return {...process,dir,async close(){await process.stop();await rm(dir,{recursive:true,force:true});}};
}
export async function cli(url,args,input='',extra={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['bin/hosta.mjs',...args],{cwd:root,env:{...process.env,HOSTA_URL:url,HOSTA_API_TOKEN:'test-management',HOSTA_WEBHOOK_KEY:'',...extra},stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.once('error',reject);
    child.once('close',code=>{let body;try{body=JSON.parse(out);}catch{}resolve({code,body,out,err});});child.stdin.end(input);
  });
}
