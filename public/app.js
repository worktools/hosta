const $ = (selector, node = document) => node.querySelector(selector);
const apps = $('#apps');
function text(node, value) { node.textContent = value; }
async function request(path, options = {}) { const res = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options }); const data = await res.json(); if (!res.ok) throw new Error(data.error?.message || 'Request failed'); return data; }
function prettyDiagnostics(items = []) { return items.map((item) => `[${item.severity}] ${item.code}: ${item.message}`).join('\n') || '尚未执行诊断。'; }
function renderApp(app) {
  const node = $('#app-template').content.firstElementChild.cloneNode(true); const draft = app.draftVersion;
  text($('.app-id', node), app.id); text($('.app-name', node), app.name); text($('.app-desc', node), app.description);
  const status = $('.status', node); const published = app.publishedVersionId === draft?.id; text(status, published ? '已发布' : draft?.status || '尚未生成'); status.className = `status ${published ? 'published' : draft?.status || ''}`;
  text($('.version', node), draft ? `v${draft.number} · ${draft.source}\n${draft.summary}` : '尚无版本');
  const editor = $('.code-editor', node); editor.value = draft?.code || ''; const input = $('.run-input', node); input.value = JSON.stringify(app.sampleInput || {}, null, 2);
  const output = $('.output', node); const diagnosticPanel = $('.diagnostics', node); text(diagnosticPanel, prettyDiagnostics(draft?.diagnostics));
  const lastRun = app.runs?.[0]; text($('.runs', node), lastRun ? `最近运行：${lastRun.status} · ${lastRun.trigger} · ${lastRun.durationMs ?? 0} ms` : '尚无运行记录');
  const deployment = $('.deployment', node); if (app.deployments?.[0]) text(deployment, `已发布：POST /hooks/${app.deployments[0].id}\n使用创建时显示的 Bearer key 调用。`);
  const readInput = () => JSON.parse(input.value);
  $('.save', node).onclick = async () => { try { const version = await request(`/api/apps/${app.id}/versions`, { method: 'POST', body: JSON.stringify({ code: editor.value }) }); text(diagnosticPanel, prettyDiagnostics(version.diagnostics)); text(output, `已保存为 v${version.number}（${version.status}）。刷新后可运行或发布此版本。`); } catch (err) { text(output, `保存失败：${err.message}`); } };
  $('.diagnose', node).onclick = async () => { try { const result = await request(`/api/versions/${draft.id}/diagnose`, { method: 'POST', body: JSON.stringify(readInput()) }); text(diagnosticPanel, prettyDiagnostics(result.diagnostics)); if (result.run) text(output, JSON.stringify(result.run, null, 2)); } catch (err) { text(diagnosticPanel, `诊断失败：${err.message}`); } };
  $('.run', node).onclick = async () => { try { const run = await request(`/api/versions/${draft.id}/run`, { method: 'POST', body: JSON.stringify(readInput()) }); text(output, JSON.stringify(run, null, 2)); text($('.runs', node), `最近运行：${run.status} · ${run.trigger} · ${run.durationMs ?? 0} ms`); } catch (err) { text(output, `运行失败：${err.message}`); } };
  $('.publish', node).onclick = async () => { try { const result = await request(`/api/apps/${app.id}/publish`, { method: 'POST', body: JSON.stringify({ versionId: draft.id }) }); text(status, '已发布'); status.className = 'status published'; text(deployment, `已发布\nWebhook: ${location.origin}${result.webhookUrl}\nBearer key（仅显示一次）: ${result.webhookKey}`); } catch (err) { text(output, `无法发布：${err.message}`); } };
  const list = $('.schedule-list', node); const showSchedules = () => text(list, app.schedules?.length ? app.schedules.map((s) => `${s.status} · 每 ${s.intervalSeconds} 秒 · 下次 ${new Date(s.nextRunAt).toLocaleString()}`).join('\n') : '尚无定时任务'); showSchedules();
  $('.schedule', node).onclick = async () => { try { const schedule = await request(`/api/apps/${app.id}/schedules`, { method: 'POST', body: JSON.stringify({ versionId: draft.id, intervalSeconds: Number($('.schedule-interval', node).value), input: readInput() }) }); app.schedules = [...(app.schedules || []), schedule]; showSchedules(); } catch (err) { text(output, `无法创建定时任务：${err.message}`); } };
  return node;
}
async function loadApps() { try { const data = await request('/api/apps'); apps.replaceChildren(...(data.length ? data.map(renderApp) : [Object.assign(document.createElement('p'), { className: 'muted', textContent: '还没有应用。创建第一个自动化吧。' })])); } catch (err) { apps.textContent = `加载失败：${err.message}`; } }
$('#refresh').onclick = loadApps;
$('#create-form').onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.target); const problem = $('#form-error'); text(problem, ''); try { const sampleInput = JSON.parse(form.get('sample') || '{}'); const app = await request('/api/apps', { method: 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description'), sampleInput }) }); await request(`/api/apps/${app.id}/generate`, { method: 'POST', body: '{}' }); event.target.reset(); await loadApps(); } catch (err) { text(problem, err.message === 'Unexpected token' ? '示例输入必须是合法 JSON' : err.message); } };
fetch('/health').then((r) => r.json()).then((health) => text($('#generator'), health.generator === 'deepseek' ? 'DeepSeek 已连接' : '本地演示生成器')).catch(() => text($('#generator'), '服务未连接'));
loadApps();
