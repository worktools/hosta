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
