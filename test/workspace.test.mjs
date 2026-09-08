import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tsImport } from 'tsx/esm/api';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hosta } from './support.mjs';
const { RunList } = await tsImport('../frontend/src/Workspace.jsx', import.meta.url);

test('read-only run list renders loading, failure, empty and paginated summaries', () => {
  const render = props => renderToStaticMarkup(React.createElement(RunList,{offset:0,onPage(){},onOpen(){},...props}));
  assert.match(render({loading:true}),/role="status"/);
  assert.match(render({error:'offline'}),/role="alert"/);
  assert.match(render({data:{items:[],nextOffset:null}}),/当前筛选下没有运行记录/);
  const html=render({data:{items:[{id:'r1',status:'failed',trigger:'retry',versionId:'v1',retryOf:'r0',errorCode:'USER_CODE_ERROR',createdAt:'2026-09-08T00:00:00Z',input:{secret:'NOT_RENDERED'}}],nextOffset:20}});
  assert.match(html,/查看运行 r1/);assert.match(html,/USER_CODE_ERROR/);assert.match(html,/重试来源/);
  assert.doesNotMatch(html,/NOT_RENDERED/);
  assert.match(html,/aria-label="运行记录分页"/);
});

test('summary API excludes heavy data and full detail remains available',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'hosta-summary-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'data.json');
  const large='PRIVATE_'.repeat(8000);
  const app={id:'a',serial:1,code:'1-a',name:'App',description:'summary',runtime:'javascript',draftVersionId:'v',publishedVersionId:null};
  const version={id:'v',appId:'a',number:1,status:'ready',code:large,codeSha256:'abc',tests:[]};
  const run={id:'r',appId:'a',versionId:'v',status:'failed',trigger:'manual',input:{large},result:large,logs:[{message:large}],error:{code:'USER_CODE_ERROR',message:large}};
  await writeFile(file,JSON.stringify({apps:[app],versions:[version],runs:[run],deployments:[]}));
  const server=await hosta('http://127.0.0.1:1',{HOSTA_DATA_FILE:file});t.after(()=>server.close());
  const get=async path=>{const response=await fetch(server.url+path,{headers:{authorization:'Bearer test-management'}});assert.equal(response.status,200);return response.text();};
  const full=await get('/api/apps');
  const brief=await get('/api/apps?view=summary');
  assert.ok(brief.length<full.length/100);
  assert.doesNotMatch(brief,/PRIVATE_|sampleInput|datasource|"runs"|"tests"/);
  assert.equal(JSON.parse(brief)[0].draftVersion.codeSha256,'abc');
  const summary=await get('/api/runs?view=summary&appId=a');
  assert.doesNotMatch(summary,/PRIVATE_|"input"|"result"|"logs"/);
  assert.equal(JSON.parse(summary).items[0].errorCode,'USER_CODE_ERROR');
  assert.equal(JSON.parse(await get('/api/runs/r')).input.large,large);
  assert.equal(JSON.parse(await get('/api/runs')).items[0].input.large,large);
  assert.equal((await fetch(server.url+'/api/apps?view=summary')).status,401);
});
