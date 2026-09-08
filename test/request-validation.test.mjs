import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hosta} from './support.mjs';

test('management input errors stay machine-readable with and without idempotency', async t => {
  const server=await hosta('http://127.0.0.1:1');t.after(()=>server.close());
  for (const key of [undefined,'invalid-body']) {
    for (const [body,status,code] of [['{',400,'INVALID_JSON'],['null',400,'INVALID_REQUEST'],['[]',400,'INVALID_REQUEST'],['"text"',400,'INVALID_REQUEST'],[JSON.stringify({name:'x'.repeat(2*1024*1024)}),413,'PAYLOAD_TOO_LARGE']]) {
      const response=await fetch(server.url+'/api/apps',{method:'POST',headers:{authorization:'Bearer test-management',...(key?{'idempotency-key':key}:{})},body});
      assert.equal(response.status,status);assert.equal((await response.json()).error.code,code);
    }
  }
  const unauthorized=await fetch(server.url+'/api/apps',{method:'POST',body:'{'});
  assert.equal(unauthorized.status,401);
  for (const path of ['/api/unknown','/invoke/unknown/extra','/hooks/unknown/extra']) {
    const response=await fetch(server.url+path,{headers:{authorization:'Bearer test-management'}});
    assert.equal(response.status,404);assert.equal((await response.json()).error.code,'NOT_FOUND');
  }
  const created=await fetch(server.url+'/api/apps',{method:'POST',headers:{authorization:'Bearer test-management','idempotency-key':'invalid-body'},body:'{"name":"still healthy","description":"recovery check"}'});
  assert.equal(created.status,201);
});
