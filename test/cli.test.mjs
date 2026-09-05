import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cli,hosta } from './support.mjs';

test('CLI/API lifecycle, idempotency, version selection, stable publication key and failures',async t=>{
  const mock=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/capabilities')return res.end(JSON.stringify({protocolVersions:['1'],runtimes:['javascript','wasm'],wasmAbi:'hoya-json-v1'}));
    let bytes='';for await(const c of req)bytes+=c;
    const data=JSON.parse(bytes), failed=data.code.includes('throw');
    res.end(JSON.stringify({protocolVersion:'1',runId:data.runId,artifactSha256:data.artifactSha256,status:failed?'failed':'succeeded',result:failed?null:data.input,logs:[{level:'info',message:'fixture',fields:null,at:1}],metrics:{durationMs:1},error:failed?{code:'USER_CODE_ERROR',message:'fixture error',retryable:false}:null}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>mock.close(r)));
  const server=await hosta(`http://127.0.0.1:${mock.address().port}`);t.after(()=>server.close());
  const call=(args,input='',env={})=>cli(server.url,args,input,env);
  assert.equal((await call(['doctor'])).code,0);
  const creation=['apps','create','--name','agent-test','--idempotency-key','app-key'];
  const [created,replayed]=await Promise.all([call(creation),call(creation)]);
  assert.equal(created.code,0);assert.equal(replayed.body.data.id,created.body.data.id);
  const app=created.body.data;
  assert.equal((await call(['apps','create','--name','different','--idempotency-key','app-key'])).body.error.code,'IDEMPOTENCY_CONFLICT');
  const upload=['versions','upload','--app',app.id,'--source','-','--idempotency-key','version-key'];
  const version=(await call(upload,'async function main(input) { return input; }')).body.data;
  assert.equal((await call(upload,'async function main(input) { return input; }')).body.data.id,version.id);
  assert.equal((await call(['publish','--app',app.id,'--version',version.id])).body.error.code,'TRIAL_REQUIRED');
  const input={text:'`${doNotExecute()}` 中文',nested:[null,true]};
  const run=await call(['run','--version',version.id,'--input','-','--json','--wait'],JSON.stringify(input));
  assert.equal(run.code,0);assert.deepEqual(run.body.data.result,input);assert.equal(run.err,'');
  assert.equal((await call(['runs','get','--run',run.body.data.id])).body.data.versionId,version.id);
  assert.equal((await call(['runs','logs','--run',run.body.data.id])).body.data.logs[0].message,'fixture');
  const pub=(await call(['publish','--app',app.id,'--version',version.id])).body.data;
  assert.ok(pub.webhookKey);
  assert.equal((await call(['publish','--app',app.id,'--version',version.id])).body.data.webhookKey,undefined);
  const invoke=await call(['invoke','--code',app.code,'--input','-'],JSON.stringify(input),{HOSTA_WEBHOOK_KEY:pub.webhookKey});
  assert.equal(invoke.code,0);assert.deepEqual(invoke.body.data.result,input);
  const publicApp=(await call(['apps','get','--app',app.id])).body.data;
  assert.equal(publicApp.deployments[0].keyHash,undefined);
  assert.equal((await call(['runs','list','--app',app.id,'--limit','1'])).body.data.items.length,1);
  const bad=(await call(['versions','upload','--app',app.id,'--source','-'],'function main() { throw new Error("bad"); }')).body.data;
  assert.equal((await call(['run','--version',bad.id])).code,4);
  assert.equal((await call(['apps','list'],'',{HOSTA_API_TOKEN:'invalid'})).code,3);
  assert.equal((await call(['run','--version','missing'])).body.error.code,'NOT_FOUND');
  assert.equal((await call(['run','--version',version.id,'--input','-'],'{bad')).code,2);
  assert.equal((await call(['publish','--app',app.id])).code,2);
  assert.equal((await call(['unknown'])).code,2);
  assert.equal((await call(['--version'])).body.data.cliSchemaVersion,'1');
});

test('transport, invalid JSON and deadline errors are machine readable',async t=>{
  assert.equal((await cli('http://127.0.0.1:1',['apps','list'])).code,5);
  const server=createServer((req,res)=>{if(req.url==='/api/apps')res.end('not-json');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await cli(url,['apps','list'])).code,6);
  assert.equal((await cli(url,['status','--timeout','30'])).body.error.code,'COMMAND_TIMEOUT');
});
