import React, { useEffect, useState } from 'react';

// Abort old requests on selection/filter changes; never display another selection's data.
export function useResource(path, refresh = 0) {
  const key = `${path}:${refresh}`;
  const [state, setState] = useState({});
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ key, loading: true });
    (async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(response.status === 401 ? '需要管理凭据，请通过已配置凭据的 CLI 查询。' : data.error?.message || '读取失败');
        if (!controller.signal.aborted) setState({ key, data, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, error: error.message, loading: false });
      }
    })();
    return () => controller.abort();
  }, [path, refresh]);
  return state.key === key ? state : { loading: Boolean(path) };
}

export function RunList({ loading, error, data, offset, onPage, onOpen, renderDetail }) {
  if (loading) return <p role="status">正在读取运行记录…</p>;
  if (error) return <p role="alert">{error}</p>;
  return <>
    {!data?.items?.length && <p>当前筛选下没有运行记录。</p>}
    {data?.items?.map(run => <div className="info" key={run.id}>
      <button onClick={() => onOpen(run.id)} aria-label={`查看运行 ${run.id}`}>{run.status} · {run.trigger} · {run.durationMs ?? '—'}ms</button>
      <p><code>{run.id}</code></p><p>版本：<code>{run.versionId}</code></p>
      <time dateTime={run.createdAt}>{run.createdAt}</time>
      {run.errorCode && <p>{run.errorCode}</p>}
      {run.retryOf && <p>重试来源：<code>{run.retryOf}</code></p>}
      {renderDetail?.(run.id)}
    </div>)}
    <nav aria-label="运行记录分页">
      <button disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - 20))}>上一页</button>{' '}
      <span>第 {Math.floor(offset / 20) + 1} 页</span>{' '}
      <button disabled={data?.nextOffset == null} onClick={() => onPage(data.nextOffset)}>下一页</button>
    </nav>
  </>;
}

function RunDetail({ id, refresh, close }) {
  const result = useResource(`/api/runs/${encodeURIComponent(id)}`, refresh);
  return <section className="info" aria-label="运行详情">
    <h3>运行详情 <button onClick={close}>关闭</button></h3>
    {result.loading ? <p role="status">正在读取详情…</p> : result.error ? <p role="alert">{result.error}</p> : <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result.data, null, 2)}</pre>}
  </section>;
}
function Runs({ appId, refresh }) {
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [opened, open] = useState(null);
  const query = new URLSearchParams({ appId, view: 'summary', limit: '20', offset: String(offset) });
  if (status) query.set('status', status);
  const result = useResource(`/api/runs?${query}`, refresh);
  return <section>
    <h2>运行记录</h2>
    <label>状态筛选 <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); open(null); }}>
      <option value="">全部</option>
      {['running','succeeded','failed','timed_out','rejected','internal_error'].map(s => <option key={s}>{s}</option>)}
    </select></label>
    <RunList {...result} offset={offset} onPage={n => { setOffset(n); open(null); }} onOpen={open} renderDetail={id => opened === id ? <RunDetail key={id} id={id} refresh={refresh} close={() => open(null)}/> : null}/>
  </section>;
}

export default function Workspace() {
  const [refresh, setRefresh] = useState(0);
  const [selectedId, select] = useState(null);
  const apps = useResource('/api/apps?view=summary', refresh);
  const status = useResource('/api/status', refresh);
  const selected = apps.data?.find(a => a.id === selectedId) || apps.data?.[0];
  return <div className="shell"><aside>
    <div className="brand"><span className="mark">H</span>hosta</div><p>工作区状态</p>
    <div className="app-nav">{apps.data?.map(a => <button key={a.id} className={selected?.id === a.id ? 'selected' : ''} onClick={() => select(a.id)}>{a.name}</button>)}</div>
    <a href="/llms.txt">CLI / API 指南 ↗</a>
    <div className="sidebar-bottom">{status.loading ? '正在检查引擎…' : status.error ? '引擎状态读取失败' : status.data?.engine?.status === 'ready' ? 'Hoya v1 已就绪' : 'Hoya 未就绪'}<br/>{status.data?.generator || '模型状态未知'}</div>
  </aside><main>
    <header><div><span className="crumb">CLI workspace / 只读展示</span><h1>{selected?.name || '程序与运行状态'}</h1></div><button onClick={() => setRefresh(n => n + 1)}>刷新</button></header>
    <section className="page">
      <p className="lead">创建和发布通过 CLI 完成：<code>hosta --help</code></p>
      {status.error && <p role="alert">{status.error}</p>}
      {status.data?.engine?.error && <p role="status">{status.data.engine.error.code}：{status.data.engine.error.message}</p>}
      {apps.loading ? <p role="status">正在读取应用…</p> : apps.error ? <p role="alert">{apps.error}</p> : !selected ? <p>暂无程序。使用 <code>hosta apps create --name example</code> 创建。</p> : <>
        <div className="info-grid"><div className="info"><h3>应用</h3><p>{selected.description}</p><code>{selected.id}</code><p>{selected.runtime}</p><code>POST /invoke/{selected.code}</code></div>
        <div className="info"><h3>草稿与线上版本</h3><p>草稿：{selected.draftVersion?.id || '无'} · {selected.draftVersion?.status || '未上传'}</p><p>线上：{selected.publishedVersion?.id || '未发布'}</p><p>产物 SHA-256</p><code style={{overflowWrap:'anywhere'}}>{selected.draftVersion?.codeSha256 || '无'}</code></div></div>
        <Runs key={`${selected.id}:${refresh}`} appId={selected.id} refresh={refresh}/>
      </>}
    </section>
  </main></div>;
}
