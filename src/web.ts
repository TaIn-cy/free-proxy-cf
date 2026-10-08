async function secureEqual(left: string, right: string): Promise<boolean> {
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(aHash);
  const b = new Uint8Array(bHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

export async function isAdminAuthorized(request: Request, adminKey: string): Promise<boolean> {
  if (!adminKey) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== "admin") return false;
    return secureEqual(decoded.slice(separator + 1), adminKey);
  } catch {
    return false;
  }
}

export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin && request.headers.get("X-Requested-With") === "free-proxy-cf";
}

export function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Free Proxy Monitor", charset="UTF-8"' },
  });
}

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>代理节点监控</title>
<style>
:root{color-scheme:dark;--bg:#171717;--panel:#1d1d1d;--border:#2e2e2e;--strong:#393939;--text:#fafafa;--muted:#898989;--green:#3ecf8e;--red:#f87171;--amber:#fbbf24}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{width:min(1180px,calc(100% - 32px));margin:auto;padding:32px 0 64px}header{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:28px}h1{margin:0;font-size:28px;font-weight:500;letter-spacing:-.6px}.eyebrow{color:var(--green);font:12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:5px}.sub{color:var(--muted);margin-top:4px}.actions{display:flex;gap:8px}.button,select{border:1px solid var(--strong);background:#0f0f0f;color:var(--text);border-radius:999px;padding:9px 16px;font:inherit}.button{cursor:pointer}.button.primary{border-color:rgba(62,207,142,.5);color:var(--green)}.button:disabled{opacity:.5;cursor:wait}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px}.label{font:11px ui-monospace,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:1px}.value{font-size:30px;line-height:1.1;margin-top:10px;font-weight:400}.value.green{color:var(--green)}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:20px 0 10px}.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:850px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--muted);font:11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.8px}tbody tr:hover{background:#222}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--strong);border-radius:999px;padding:3px 9px;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}.alive .dot{background:var(--green);box-shadow:0 0 10px rgba(62,207,142,.5)}.dead .dot{background:var(--red)}.pending .dot{background:var(--amber)}.empty{text-align:center!important;color:var(--muted);padding:50px!important}.foot{margin-top:12px;color:var(--muted);font-size:12px}.error{color:var(--red)}@media(max-width:720px){header{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:repeat(2,1fr)}.toolbar{align-items:flex-start;flex-direction:column}.actions{width:100%}.button{flex:1}}@media(max-width:430px){.grid{grid-template-columns:1fr 1fr}.value{font-size:24px}}
</style></head><body><main class="wrap">
<header><div><div class="eyebrow">Cloudflare Workers · D1</div><h1>代理节点监控</h1><div class="sub">自动聚合、检测并追踪 HTTP / SOCKS5 免费节点</div></div><div class="actions"><button class="button" id="reload">刷新页面</button><button class="button primary" id="run">立即检测</button></div></header>
<section class="grid"><div class="card"><div class="label">总节点</div><div class="value" id="total">—</div></div><div class="card"><div class="label">45 分钟内可用</div><div class="value green" id="alive">—</div></div><div class="card"><div class="label">HTTP</div><div class="value" id="http">—</div></div><div class="card"><div class="label">SOCKS5</div><div class="value" id="socks5">—</div></div></section>
<div class="toolbar"><div><strong>节点列表</strong><div class="sub" id="updated">正在载入…</div></div><select id="filter"><option value="alive" selected>当前可用</option><option value="all">全部候选</option><option value="dead">不可用</option><option value="pending">待检测</option></select></div>
<div class="table-wrap"><table><thead><tr><th>状态</th><th>节点</th><th>协议</th><th>延迟</th><th>来源</th><th>最后成功</th><th>连续失败</th></tr></thead><tbody id="rows"><tr><td class="empty" colspan="7">载入中…</td></tr></tbody></table></div><div class="foot">Cron 每 5 分钟检测最多 20 个节点；顶部“可用”只统计最近 45 分钟内通过随机 nonce 转发验证的节点。</div>
</main><script>
const $=id=>document.getElementById(id);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){try{const q=$('filter').value;const r=await fetch('/api/status?status='+encodeURIComponent(q));if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();$('total').textContent=d.summary.total;$('alive').textContent=d.summary.alive;$('http').textContent=d.summary.http;$('socks5').textContent=d.summary.socks5;$('updated').textContent=d.latestRun?'最近任务：'+new Date(d.latestRun.started_at).toLocaleString()+' · 检测 '+d.latestRun.checked_count+' · 可用 '+d.latestRun.alive_count:'暂无运行记录';$('rows').innerHTML=d.proxies.length?d.proxies.map(p=>'<tr><td><span class="badge '+esc(p.status)+'"><i class="dot"></i>'+esc(p.status)+'</span></td><td class="mono">'+esc(p.host)+':'+esc(p.port)+'</td><td>'+esc(p.protocol)+'</td><td>'+(p.latency_ms==null?'—':esc(p.latency_ms)+' ms')+'</td><td>'+esc(p.source)+'</td><td>'+esc(p.last_success_at||'—')+'</td><td>'+esc(p.fail_count)+'</td></tr>').join(''):'<tr><td class="empty" colspan="7">没有符合条件的节点</td></tr>'}catch(e){$('updated').innerHTML='<span class="error">载入失败：'+esc(e.message)+'</span>'}}
$('filter').addEventListener('change',load);$('reload').onclick=load;$('run').onclick=async()=>{const b=$('run');b.disabled=true;b.textContent='任务已提交';try{const r=await fetch('/api/refresh',{method:'POST',headers:{'X-Requested-With':'free-proxy-cf'}});if(!r.ok)throw new Error('HTTP '+r.status);setTimeout(load,5000)}catch(e){alert('提交失败：'+e.message)}finally{setTimeout(()=>{b.disabled=false;b.textContent='立即检测'},5000)}};load();setInterval(load,30000);
</script></body></html>`;
}
