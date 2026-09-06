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
  const api=async(path,data,method='POST')=>{const response=await fetch(server.url+path,{method,headers:{authorization:'Bearer test-management','content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(data)});return {status:response.status,body:await response.json()};};
  assert.equal((await api('/api/admin/status',null,'GET')).body.sandbox.hoyaRunning,true);
  assert.equal((await api('/api/admin/sandbox',{enabled:false})).status,409);
  const wasm=join(server.dir,'echo.wasm');
  await exec('rustc',['+stable','--edition=2021','--target','wasm32-unknown-unknown','--crate-type','cdylib','-O',join(root,'examples/echo.rs'),'-o',wasm]);
  const input={value:7,text:'`${ignored}` 中文',array:[1,null,true]};
  for(const runtime of ['javascript','wasm']) {
    const app=(await call(['apps','create','--name',runtime,'--runtime',runtime])).body.data;
    const upload=await call(['versions','upload','--app',app.id,'--runtime',runtime,'--source',runtime==='wasm'?wasm:'-'],'async function main(input,ctx) {ctx.log("info","smoke");return input;}');
    assert.equal(upload.code,0,upload.out);const version=upload.body.data;
    if(runtime==='wasm') {
      assert.equal(version.sourceCode,undefined);
      assert.equal(version.wasmSize,Buffer.from(version.code,'base64').length);
      assert.ok(!version.diagnostics.some(d=>d.code==='NO_EXPLICIT_RETURN'));
    }
    const run=await call(['run','--version',version.id,'--input','-'],JSON.stringify(input));assert.equal(run.code,0,run.out);assert.deepEqual(run.body.data.result,input);
    const published=(await call(['publish','--app',app.id,'--version',version.id])).body.data;
    const invoke=await call(['invoke','--code',app.code,'--input','-'],JSON.stringify(input),{HOSTA_WEBHOOK_KEY:published.webhookKey});assert.equal(invoke.code,0,invoke.out);assert.deepEqual(invoke.body.data.result,input);
    assert.equal((await call(['runs','get','--run',invoke.body.data.id])).body.data.artifactSha256,version.codeSha256);
    const dep=(await call(['deployments','get','--app',app.id])).body.data;
    assert.equal(dep.keyHash,undefined);assert.equal(dep.webhookKey,undefined);
    const version2=(await call(['versions','upload','--app',app.id,'--runtime',runtime,'--source',runtime==='wasm'?wasm:'-'],'function main(input){return input;}')).body.data;
    assert.equal((await call(['deployments','rollback','--deployment',dep.id,'--version',version2.id])).body.error.code,'TRIAL_REQUIRED');
    assert.equal((await call(['run','--version',version2.id])).code,0);
    assert.equal((await call(['publish','--app',app.id,'--version',version2.id])).body.data.webhookKey,undefined);
    const invokeWith=key=>call(['invoke','--code',app.code], '', {HOSTA_WEBHOOK_KEY:key});
    assert.equal((await invokeWith(published.webhookKey)).body.data.versionId,version2.id);
    assert.equal((await call(['deployments','rollback','--deployment',dep.id])).code,2);
    assert.equal((await api('/api/deployments/'+dep.id+'/rollback',{})).body.error.code,'VERSION_REQUIRED');
    assert.equal((await call(['deployments','rollback','--deployment',dep.id,'--version',version.id])).body.data.versionId,version.id);
    assert.equal((await invokeWith(published.webhookKey)).body.data.versionId,version.id);
    const other=(await call(['apps','create','--name','other'])).body.data;
    const foreign=(await call(['versions','upload','--app',other.id,'--source','-'],'function main(input){return input;}')).body.data;
    assert.equal((await call(['deployments','rollback','--deployment',dep.id,'--version',foreign.id])).body.error.code,'NOT_FOUND');
    assert.equal((await call(['deployments','disable','--deployment',dep.id])).code,0);
    assert.notEqual((await invokeWith(published.webhookKey)).code,0);
    assert.equal((await call(['deployments','rollback','--deployment',dep.id,'--version',version.id])).body.error.code,'DEPLOYMENT_INACTIVE');
    assert.equal((await call(['publish','--app',app.id,'--version',version.id])).body.data.webhookKey,undefined);
    assert.equal((await invokeWith(published.webhookKey)).code,0);
    const rotated=await call(['deployments','rotate-key','--deployment',dep.id]);assert.equal(rotated.code,0,rotated.out);
    assert.notEqual(rotated.body.data.webhookKey,published.webhookKey);assert.equal(rotated.err,'');
    assert.equal((await invokeWith(published.webhookKey)).code,3);
    assert.equal((await invokeWith(rotated.body.data.webhookKey)).code,0);
    assert.ok(!(await call(['deployments','get','--app',app.id])).out.includes(rotated.body.data.webhookKey));
    if(runtime==='javascript') {
      const ds={message:'` ${inert} \" 中文',items:[1,2]};
      const saved=await fetch(server.url+'/api/apps/'+app.id+'/datasource',{method:'PUT',headers:{authorization:'Bearer test-management','content-type':'application/json'},body:JSON.stringify({data:ds})});
      assert.equal(saved.status,200);
      const withData=(await call(['versions','upload','--app',app.id,'--source','-'],'function main(input,ctx){return ctx.datasource;}')).body.data;
      const dsRun=await call(['run','--version',withData.id]);assert.equal(dsRun.code,0,dsRun.out);assert.deepEqual(dsRun.body.data.result,ds);
      const migration=await api('/api/apps/'+app.id+'/datasource/migrate',{script:'data.count=3; console.log("migrated");'});
      assert.equal(migration.status,200,JSON.stringify(migration.body));assert.equal(migration.body.after.count,3);
      const unchanged=await api('/api/apps/'+app.id+'/datasource',null,'GET');assert.deepEqual(unchanged.body.data,ds);
      const page=await api('/api/apps/'+app.id+'/pages',{name:'test',processScript:'(input,datasource)=>({input,datasource})'});assert.equal(page.status,201);
      const processed=await api('/api/apps/'+app.id+'/pages/'+page.body.id+'/data',input);assert.deepEqual(processed.body.data,{input,datasource:ds});
      const syntax=(await call(['versions','upload','--app',app.id,'--source','-'],'function main(){return (;}')).body.data;
      assert.ok(syntax.diagnostics.some(d=>d.code==='ENGINE_VALIDATION_REQUIRED'));
      assert.equal((await call(['run','--version',syntax.id])).code,4);
      assert.notEqual((await call(['publish','--app',app.id,'--version',syntax.id])).code,0);
      const bad=(await call(['versions','upload','--app',app.id,'--source','-'],'function main(){while(true){}}')).body.data;
      const timeout=await call(['run','--version',bad.id]);assert.equal(timeout.code,4,timeout.out);assert.equal(timeout.body.data.status,'timed_out');
      assert.equal((await call(['run','--version',version.id])).code,0);
    }
  }
  await engine.stop();
  assert.equal((await call(['doctor'])).code,5);
  assert.equal((await call(['apps','list'])).code,0);
});
