import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryRuns } from '../dist/run-query.js';

test('run pagination preserves filtering/order and stops after one page plus lookahead', () => {
  const runs = Array.from({length:100000}, (_,i) => ({id:String(i),appId:i%2?'a':'b',versionId:'v',status:'succeeded',trigger:'manual',input:{large:'x'.repeat(100)},result:'private',logs:[{message:'private'}],error:null}));
  let reads = 0;
  const observed = new Proxy(runs, {get(target,key) {if (/^\d+$/.test(String(key))) reads++;return Reflect.get(target,key);}});
  const page = queryRuns(observed, new URLSearchParams('limit=20&view=summary'));
  assert.equal(reads,21);
  assert.equal(page.nextOffset,20);
  assert.equal(page.items[0].id,'99999');
  assert.equal(page.items[19].id,'99980');
  for(const item of page.items) for(const field of ['input','result','logs','error']) assert.equal(field in item,false);
  const query = new URLSearchParams('appId=a&status=succeeded&trigger=manual&offset=3&limit=7');
  const filtered = queryRuns(runs,query);
  assert.deepEqual(filtered.items,runs.filter(r=>r.appId==='a').reverse().slice(3,10));
  assert.equal(filtered.nextOffset,10);
  assert.deepEqual(queryRuns(runs,new URLSearchParams('offset=100000')), {items:[],nextOffset:null});
  assert.equal(queryRuns(runs,new URLSearchParams('offset=99990&limit=10')).nextOffset,null);
  for(const pagination of ['limit=101','limit=0','offset=-1','offset=9007199254740992','limit=NaN']) assert.throws(()=>queryRuns(runs,new URLSearchParams(pagination)));
});
