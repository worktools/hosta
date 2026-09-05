import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function api(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '读取失败');
  return data;
}
function App() {
  const [apps, setApps] = useState([]);
  const [status, setStatus] = useState(null);
  const [selectedId, select] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { const [items, state] = await Promise.all([api('/api/apps'), api('/api/status')]); setApps(items); setStatus(state); setError(''); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  const selected = apps.find(a => a.id === selectedId) || apps[0];
  return <div className="shell"><aside>
    <div className="brand"><span className="mark">H</span>hosta</div>
    <p>工作区状态</p>
    <div className="app-nav">{apps.map(a => <button key={a.id} className={selected?.id === a.id ? 'selected' : ''} onClick={() => select(a.id)}>{a.name}</button>)}</div>
    <a href="/llms.txt">CLI / API 指南 ↗</a>
    <div className="sidebar-bottom">{status?.engine?.status === 'ready' ? 'Hoya v1 已就绪' : 'Hoya 未就绪'}<br/>{status?.generator || '模型状态未知'}</div>
  </aside><main>
    <header><div><span className="crumb">CLI workspace / 只读展示</span><h1>{selected?.name || '程序与运行状态'}</h1></div><button disabled={loading} onClick={refresh}>{loading ? '读取中…' : '刷新'}</button></header>
    {error && <div className="notice" role="alert">{error}。配置了管理凭据时，请使用 CLI 查询。</div>}
    <section className="page">
      <p className="lead">创建、上传版本、试运行和发布通过 CLI 完成：<code>node bin/hosta.mjs --help</code></p>
      {status?.engine?.error && <p role="status">{status.engine.error.code}：{status.engine.error.message}</p>}
      {!selected ? <div className="empty">暂无程序。使用 <code>hosta apps create --name example</code> 创建。</div> : <>
        <div className="info-grid"><div className="info"><h3>应用</h3><p>{selected.description}</p><code>{selected.id}</code><p>{selected.runtime}</p><code>POST /invoke/{selected.code}</code></div>
        <div className="info"><h3>草稿与线上版本</h3><p>草稿：{selected.draftVersion?.id || '无'} · {selected.draftVersion?.status || '未上传'}</p><p>线上：{selected.publishedVersion?.id || '未发布'}</p><p>产物 SHA-256</p><code style={{overflowWrap:'anywhere'}}>{selected.draftVersion?.codeSha256 || '无'}</code></div></div>
        <h2>最近运行</h2>
        {!selected.runs?.length && <p>暂无运行。使用 CLI 指定版本试运行。</p>}
        {selected.runs?.map(run => <details className="info" key={run.id}><summary>{run.status} · {run.trigger} · {run.durationMs ?? '—'}ms · {run.id}</summary><p>版本：{run.versionId}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({input:run.input,result:run.result,logs:run.logs,error:run.error,artifactSha256:run.artifactSha256},null,2)}</pre></details>)}
      </>}
    </section>
  </main></div>;
}
createRoot(document.getElementById('root')).render(<App />);
