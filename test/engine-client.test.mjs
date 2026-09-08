import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {executeWithHoya,artifactHash} from '../lib/hoya-client.mjs';
test('Hosta rejects mismatched engine correlation instead of accepting success',async t=>{
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/capabilities')return res.end(JSON.stringify({protocolVersions:['1'],runtimes:['javascript','wasm'],wasmAbi:'hoya-json-v1'}));
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    res.end(JSON.stringify({protocolVersion:'1',runId:'wrong',artifactSha256:body.artifactSha256,status:'succeeded',result:1,logs:[],metrics:{durationMs:0},error:null}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  process.env.HOYA_URL=`http://127.0.0.1:${server.address().port}`;process.env.HOYA_AUTH_TOKEN='test';
  await assert.rejects(()=>executeWithHoya({code:'function main(){return 1;}',runtime:'javascript',codeSha256:artifactHash('function main(){return 1;}','javascript')},{},'expected'),{code:'ENGINE_PROTOCOL'});
  await assert.rejects(()=>executeWithHoya({code:'function main(){return 2;}',runtime:'javascript',codeSha256:'0'.repeat(64)},{},'expected'),{code:'ARTIFACT_HASH_MISMATCH'});
  assert.equal(artifactHash('YQ==','wasm'),artifactHash('a','javascript'));
});

test('engine response validation rejects malformed fields and strips control-plane overrides',async t=>{
  let change=data=>data;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/capabilities')return res.end(JSON.stringify({protocolVersions:['1'],runtimes:['javascript','wasm'],wasmAbi:'hoya-json-v1'}));
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    res.end(JSON.stringify(change({protocolVersion:'1',runId:body.runId,artifactSha256:body.artifactSha256,status:'succeeded',result:1,logs:[],metrics:{durationMs:0},error:null})));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  process.env.HOYA_URL=`http://127.0.0.1:${server.address().port}`;process.env.HOYA_AUTH_TOKEN='test';
  const code='function main(){return 1;}';
  const execute=()=>executeWithHoya({code,runtime:'javascript',codeSha256:artifactHash(code,'javascript')},{},'expected');
  for (const mutate of [()=>null,d=>({...d,logs:[null]}),d=>({...d,logs:[{level:'info',message:'x',at:1e20}]}),d=>({...d,metrics:{durationMs:-1}}),d=>({...d,status:'failed',error:{code:'BAD'}})]) {
    change=mutate;await assert.rejects(execute,{code:'ENGINE_PROTOCOL'});
  }
  change=d=>({...d,id:'overwrite',appId:'other',versionId:'other',input:'overwrite',deploymentEventId:'other'});
  const response=await execute();
  for(const field of ['id','appId','versionId','input','deploymentEventId'])assert.ok(!Object.hasOwn(response,field));
  assert.equal(response.runId,'expected');assert.equal(response.result,1);
});
