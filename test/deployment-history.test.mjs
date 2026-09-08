import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, hosta, startProcess } from './support.mjs';

test('deployment history survives restart and in-flight invokes retain their deployment event', async t => {
  let entered;
  let release;
  const mock = createServer(async (req,res) => {
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/capabilities')return res.end(JSON.stringify({protocolVersions:['1'],runtimes:['javascript','wasm'],wasmAbi:'hoya-json-v1'}));
    let bytes='';for await(const c of req)bytes+=c;const data=JSON.parse(bytes);
    if(entered) {const notify=entered;entered=null;await new Promise(resolve=>{release=resolve;notify();});}
    res.end(JSON.stringify({protocolVersion:'1',runId:data.runId,artifactSha256:data.artifactSha256,status:'succeeded',result:data.input,logs:[],metrics:{durationMs:1},error:null}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  t.after(()=>{release?.();mock.closeAllConnections();return new Promise(r=>mock.close(r));});
  const server=await hosta(`http://127.0.0.1:${mock.address().port}`);t.after(()=>server.close());
  const call=(args,source='',env={})=>cli(server.url,args,source,env);
  const api=async(path,data)=>{const res=await fetch(server.url+path,{method:'POST',headers:{authorization:'Bearer test-management','content-type':'application/json'},body:JSON.stringify(data)});return {status:res.status,body:await res.json()};};
  const app=(await call(['apps','create','--name','events'])).body.data;
  const upload=()=>call(['versions','upload','--app',app.id,'--source','-'],'function main(input){return input;}');
  const v1=(await upload()).body.data, v2=(await upload()).body.data;
  for(const v of [v1,v2])assert.equal((await call(['run','--version',v.id])).code,0);
  assert.equal((await api(`/api/apps/${app.id}/set-default-version`,{versionId:v1.id})).body.error.code,'DEPLOYMENT_INACTIVE');
  const pub=(await call(['publish','--app',app.id,'--version',v1.id])).body.data;
  const dep=pub.deployment;
  const history=()=>call(['deployments','history','--deployment',dep.id]);
  const first=(await history()).body.data.items[0];
  assert.equal(first.action,'publish');assert.equal(first.previousVersionId,null);
  assert.equal(first.id,dep.lastEventId);assert.equal(first.artifactSha256,v1.codeSha256);
  const ready=new Promise(r=>{entered=r;});
  const invoke=call(['invoke','--code',app.code], '', {HOSTA_WEBHOOK_KEY:pub.webhookKey});
  await ready;
  let upgraded;
  try {upgraded=(await call(['publish','--app',app.id,'--version',v2.id])).body.data;}
  finally {release();}
  const original=(await invoke).body.data;
  assert.equal(original.versionId,v1.id);assert.equal(original.deploymentId,dep.id);assert.equal(original.deploymentEventId,first.id);
  const current=(await call(['invoke','--code',app.code], '', {HOSTA_WEBHOOK_KEY:pub.webhookKey})).body.data;
  assert.equal(current.versionId,v2.id);assert.equal(current.deploymentEventId,upgraded.deployment.lastEventId);
  for (const [path, expectedVersion] of [[`/invoke-version/${app.code}/${v1.number}`,v1.id],[`/hooks/${dep.id}`,v2.id]]) {
    const response=await fetch(server.url+path,{method:'POST',headers:{authorization:`Bearer ${pub.webhookKey}`,'content-type':'application/json'},body:'{}'});
    const run=await response.json();
    assert.equal(response.status,200);assert.equal(run.versionId,expectedVersion);
    assert.equal(run.deploymentId,dep.id);assert.equal(run.deploymentEventId,upgraded.deployment.lastEventId);
  }
  assert.equal((await call(['deployments','rollback','--deployment',dep.id,'--version',v1.id])).code,0);
  assert.equal((await call(['deployments','disable','--deployment',dep.id])).code,0);
  assert.equal((await api(`/api/apps/${app.id}/set-default-version`,{versionId:v1.id})).body.error.code,'DEPLOYMENT_INACTIVE');
  assert.equal((await call(['publish','--app',app.id,'--version',v1.id])).code,0);
  const rotation=await call(['deployments','rotate-key','--deployment',dep.id]);assert.equal(rotation.code,0);
  assert.equal((await api(`/api/apps/${app.id}/set-default-version`,{versionId:v2.id})).status,200);
  const result=await history();const events=result.body.data.items;
  assert.deepEqual(events.map(e=>e.action),['set_default','rotate_key','restore','disable','rollback','publish','publish']);
  assert.deepEqual(events.at(-1),first);
  assert.ok(!result.out.includes(pub.webhookKey));assert.ok(!result.out.includes(rotation.body.data.webhookKey));assert.ok(!result.out.includes('keyHash'));
  const page=(await call(['deployments','history','--deployment',dep.id,'--offset','1','--limit','2'])).body.data;
  assert.deepEqual(page.items,events.slice(1,3));assert.equal(page.nextOffset,3);
  assert.equal((await call(['deployments','history','--deployment',dep.id,'--limit','0'])).code,1);
  assert.equal((await call(['deployments','history','--deployment',dep.id],'',{HOSTA_API_TOKEN:'bad'})).code,3);
  const saved=JSON.parse(await readFile(join(server.dir,'hosta.json'),'utf8'));
  assert.equal(saved.deploymentEvents.length,7);
  await server.stop();
  const restarted=await startProcess(process.execPath,['dist/index.js'],{PORT:'0',HOSTA_DATA_FILE:join(server.dir,'hosta.json'),HOSTA_API_TOKEN:'test-management'});
  try {assert.deepEqual((await cli(restarted.url,['deployments','history','--deployment',dep.id])).body.data.items,events);}
  finally {await restarted.stop();}
});

test('event retention bounds each deployment without deleting another deployment history', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'hosta-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  process.env.HOSTA_DATA_FILE=join(dir,'empty.json');
  const {store}=await import('../dist/store.js');
  const {recordDeploymentEvent,deploymentHistoryLimit}=await import('../dist/deployment-history.js');
  const dep={id:'d',appId:'a',versionId:'v',status:'active',keyHash:'SECRET'};
  const other=recordDeploymentEvent({...dep,id:'other'},'publish',null);
  for(let i=0;i<deploymentHistoryLimit+2;i++)recordDeploymentEvent(dep,'publish','v');
  assert.equal(store.deploymentEvents.length,deploymentHistoryLimit+1);
  assert.deepEqual(store.deploymentEvents[0],other);
  assert.equal(store.deploymentEvents.at(-1).id,dep.lastEventId);
  assert.ok(!JSON.stringify(store.deploymentEvents).includes('SECRET'));
});
