import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { cli,hosta,startProcess,root } from './support.mjs';
const exec=promisify(execFile);
test('real Hoya: JS/Rust WASM CLI publish/invoke, guest timeout and engine outage', {skip:!process.env.HOYA_BINARY && 'Set HOYA_BINARY to run the real dual-engine smoke test'},async t=>{
  const engine=await startProcess(process.env.HOYA_BINARY,[],{PORT:'0',HOYA_BIND:'127.0.0.1',HOYA_AUTH_TOKEN:'test-engine',HOYA_MODE:'engine'});t.after(()=>engine.stop());
  const server=await hosta(engine.url);t.after(()=>server.close());
  const call=(args,input='',env={})=>cli(server.url,args,input,env);
  const wasm=join(server.dir,'echo.wasm');
  await exec('rustc',['+stable','--edition=2021','--target','wasm32-unknown-unknown','--crate-type','cdylib','-O',join(root,'examples/echo.rs'),'-o',wasm]);
  const input={value:7,text:'`${ignored}` 中文',array:[1,null,true]};
  for(const runtime of ['javascript','wasm']) {
    const app=(await call(['apps','create','--name',runtime,'--runtime',runtime])).body.data;
    const upload=await call(['versions','upload','--app',app.id,'--runtime',runtime,'--source',runtime==='wasm'?wasm:'-'],'async function main(input,ctx) {ctx.log("info","smoke");return input;}');
    assert.equal(upload.code,0,upload.out);const version=upload.body.data;
    const run=await call(['run','--version',version.id,'--input','-'],JSON.stringify(input));assert.equal(run.code,0,run.out);assert.deepEqual(run.body.data.result,input);
    const published=(await call(['publish','--app',app.id,'--version',version.id])).body.data;
    const invoke=await call(['invoke','--code',app.code,'--input','-'],JSON.stringify(input),{HOSTA_WEBHOOK_KEY:published.webhookKey});assert.equal(invoke.code,0,invoke.out);assert.deepEqual(invoke.body.data.result,input);
    assert.equal((await call(['runs','get','--run',invoke.body.data.id])).body.data.artifactSha256,version.codeSha256);
    if(runtime==='javascript') {
      const bad=(await call(['versions','upload','--app',app.id,'--source','-'],'function main(){while(true){}}')).body.data;
      const timeout=await call(['run','--version',bad.id]);assert.equal(timeout.code,4,timeout.out);assert.equal(timeout.body.data.status,'timed_out');
      assert.equal((await call(['run','--version',version.id])).code,0);
    }
  }
  await engine.stop();
  assert.equal((await call(['doctor'])).code,5);
  assert.equal((await call(['apps','list'])).code,0);
});
