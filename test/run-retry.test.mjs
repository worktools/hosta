import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli, hosta } from './support.mjs';

test('confirmed retries preserve version/input and lineage, without replaying active runs', async t => {
  let fail = true;
  let executions = 0;
  let unblock;
  let entered;
  const mock = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/capabilities') return res.end(JSON.stringify({protocolVersions:['1'],runtimes:['javascript','wasm'],wasmAbi:'hoya-json-v1'}));
    let bytes = ''; for await (const c of req) bytes += c;
    const data = JSON.parse(bytes);
    executions++;
    if (entered) {
      const notify = entered; entered = undefined;
      await new Promise(resolve => { unblock = resolve; notify(); });
    }
    res.end(JSON.stringify({protocolVersion:'1',runId:data.runId,artifactSha256:data.artifactSha256,status:fail?'failed':'succeeded',result:fail?null:data.input,logs:[],metrics:{durationMs:1},error:fail?{code:'USER_CODE_ERROR',message:'fixture',retryable:false}:null}));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  t.after(() => { unblock?.(); mock.closeAllConnections(); return new Promise(r => mock.close(r)); });
  const server = await hosta(`http://127.0.0.1:${mock.address().port}`);
  t.after(() => server.close());
  const call = (args, input='', env={}) => cli(server.url, args, input, env);
  const api = async (path, data) => {
    const response = await fetch(server.url + path, {method:'POST',headers:{authorization:'Bearer test-management','content-type':'application/json'},body:JSON.stringify(data)});
    return {status:response.status,body:await response.json()};
  };
  const app = (await call(['apps','create','--name','retry'])).body.data;
  const version = (await call(['versions','upload','--app',app.id,'--source','-'], 'function main(input){return input;}')).body.data;
  const input = {text:'`${notCode}` 中文', list:[null,true,7]};
  const first = await call(['run','--version',version.id,'--input','-'], JSON.stringify(input));
  assert.equal(first.code, 4);
  const original = first.body.data;
  const retryArgs = ['runs','retry','--run',original.id];
  assert.equal((await call(retryArgs)).code, 2);
  assert.equal((await call([...retryArgs,'--yes','--input','-'], '{}')).code, 2);
  assert.equal((await call([...retryArgs,'--yes'],'',{HOSTA_API_TOKEN:'invalid'})).code, 3);
  assert.equal((await api(`/api/runs/${original.id}/retry`, {})).status, 400);
  assert.equal((await api(`/api/runs/${original.id}/retry`, {confirm:true,input:{}})).body.error.code, 'INVALID_RETRY');
  assert.equal(executions, 1);
  const stillFailed = await call([...retryArgs,'--yes','--wait']);
  assert.equal(stillFailed.code, 4);
  assert.equal(stillFailed.body.data.retryOf, original.id);
  fail = false;
  const newer = (await call(['versions','upload','--app',app.id,'--source','-'], 'function main(){return "new";}')).body.data;
  const retried = await call([...retryArgs,'--yes','--wait']);
  assert.equal(retried.code, 0, retried.out);
  const next = retried.body.data;
  assert.notEqual(next.id, original.id);
  assert.equal(next.retryOf, original.id);
  assert.equal(next.trigger, 'retry');
  assert.equal(next.versionId, version.id);
  assert.notEqual(next.versionId, newer.id);
  assert.deepEqual(next.input, input);
  assert.deepEqual(next.result, input);
  assert.equal(next.artifactSha256, original.artifactSha256);
  assert.deepEqual((await call(['runs','get','--run',original.id])).body.data, original);
  const list = (await call(['runs','list','--app',app.id,'--trigger','retry','--status','succeeded','--limit','1'])).body.data;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, next.id);
  const chain = (await call(['runs','retry','--run',next.id,'--yes'])).body.data;
  assert.equal(chain.retryOf, next.id);
  // A retry is not an explicit manual trial and cannot bypass the publication gate.
  assert.equal((await call(['publish','--app',app.id,'--version',version.id])).body.error.code, 'TRIAL_REQUIRED');
  assert.equal((await call(['runs','retry','--run','missing','--yes'])).body.error.code, 'NOT_FOUND');
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = api(`/api/versions/${version.id}/run`, {});
  await ready;
  try {
    const running = (await call(['runs','list','--status','running'])).body.data.items[0];
    assert.equal((await call(['runs','retry','--run',running.id,'--yes'])).body.error.code, 'RUN_NOT_FINISHED');
  } finally { unblock(); }
  assert.equal((await pending).status, 201);
  const saved = JSON.parse(await readFile(join(server.dir,'hosta.json'),'utf8'));
  assert.equal(saved.runs.find(r => r.id === next.id).retryOf, original.id);
});
