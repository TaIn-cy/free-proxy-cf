import { checkHttpProxy, checkSocks5Proxy, type CheckResult, type Dial } from "./checker";
import { parseProxyText, type ProxyCandidate, type ProxyProtocol } from "./core";

const PUBLIC_SOURCES = [
  {
    name: "monosans-socks5",
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    defaultProtocol: "socks5" as const,
  },
  {
    name: "relayglass-socks5",
    url: "https://raw.githubusercontent.com/relayglass/free-proxy-list/main/protocol/socks5/socks5.json",
    defaultProtocol: "socks5" as const,
  },
  {
    name: "proxifly-http",
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
    defaultProtocol: "http" as const,
  },
  {
    name: "proxifly-socks5",
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    defaultProtocol: "socks5" as const,
  },
] as const;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type StoredProtocol = ProxyProtocol | "unknown";

export async function readResponseTextLimited(response: Response, maxBytes = 6_000_000): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("source response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("source response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export interface ProxyToCheck {
  host: string;
  port: number;
  protocol: StoredProtocol;
}

function rotatingWindow<T>(items: T[], limit: number, seed: number): T[] {
  if (items.length <= limit) return items;
  const offset = Math.abs(seed) % items.length;
  const rotated = items.slice(offset).concat(items.slice(0, offset));
  return rotated.slice(0, limit);
}

export async function collectSources(
  wsapiKey: string,
  fetcher: Fetcher = fetch,
  perSourceLimit = 100,
  seed = Math.floor(Date.now() / 600_000),
): Promise<ProxyCandidate[]> {
  const sources = [
    {
      name: "wsapi",
      url: `https://wsapi.top/API/proxy.php?apikey=${encodeURIComponent(wsapiKey)}`,
      defaultProtocol: undefined,
    },
    ...PUBLIC_SOURCES,
  ];
  const collected = await Promise.all(sources.map(async (source) => {
    try {
      const response = await fetcher(source.url, {
        headers: { "User-Agent": "free-proxy-cf/1" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return [];
      }
      const text = await readResponseTextLimited(response);
      const parsed = parseProxyText(text, source.name).map((candidate) => ({
        ...candidate,
        hintedProtocol: candidate.hintedProtocol ?? source.defaultProtocol ?? null,
      }));
      return rotatingWindow(parsed, perSourceLimit, seed);
    } catch {
      return [];
    }
  }));

  const unique = new Map<string, ProxyCandidate>();
  for (const candidate of collected.flat()) {
    const key = `${candidate.host}:${candidate.port}`;
    const existing = unique.get(key);
    if (!existing || (!existing.hintedProtocol && candidate.hintedProtocol)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

export async function detectProxy(
  proxy: ProxyToCheck,
  httpCheck: (host: string, port: number) => Promise<CheckResult>,
  socksCheck: (host: string, port: number) => Promise<CheckResult>,
): Promise<CheckResult> {
  if (proxy.protocol === "http") return httpCheck(proxy.host, proxy.port);
  if (proxy.protocol === "socks5") return socksCheck(proxy.host, proxy.port);
  const http = await httpCheck(proxy.host, proxy.port);
  if (http.ok) return http;
  const socks = await socksCheck(proxy.host, proxy.port);
  if (socks.ok) return socks;
  return { ...socks, error: `HTTP: ${http.error ?? "failed"}; SOCKS5: ${socks.error ?? "failed"}`.slice(0, 200) };
}

async function batchStatements(db: D1Database, statements: D1PreparedStatement[], size = 80): Promise<void> {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

export async function upsertCandidates(
  db: D1Database,
  candidates: ProxyCandidate[],
  now: string,
): Promise<void> {
  for (let index = 0; index < candidates.length; index += 400) {
    const rows = candidates.slice(index, index + 400).map((candidate) => ({
      id: `${candidate.host}:${candidate.port}`,
      host: candidate.host,
      port: candidate.port,
      protocol: candidate.hintedProtocol ?? "unknown",
      source: candidate.source,
    }));
    await db.prepare(`
      INSERT INTO proxies (id, host, port, protocol, source, status, fail_count, created_at, updated_at)
      SELECT
        json_extract(value, '$.id'),
        json_extract(value, '$.host'),
        json_extract(value, '$.port'),
        json_extract(value, '$.protocol'),
        json_extract(value, '$.source'),
        'pending', 0, ?, ?
      FROM json_each(?)
      WHERE true
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        protocol = CASE WHEN proxies.protocol = 'unknown' THEN excluded.protocol ELSE proxies.protocol END,
        updated_at = excluded.updated_at
    `).bind(now, now, JSON.stringify(rows)).run();
  }
}

export interface MaintenanceEnv {
  DB: D1Database;
  WSAPI_KEY: string;
}

export interface MaintenanceResult {
  fetched: number;
  checked: number;
  alive: number;
  error: string | null;
}

export async function runMaintenance(env: MaintenanceEnv, dial: Dial): Promise<MaintenanceResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO runs (id, started_at, fetched_count, checked_count, alive_count) VALUES (?, ?, 0, 0, 0)",
  ).bind(runId, startedAt).run();

  let fetched = 0;
  let checked = 0;
  let alive = 0;
  let error: string | null = null;
  try {
    const candidates = await collectSources(env.WSAPI_KEY);
    fetched = candidates.length;
    const now = new Date().toISOString();
    await upsertCandidates(env.DB, candidates, now);
    await env.DB.prepare(`
      DELETE FROM proxies
      WHERE id NOT IN (
        SELECT id FROM proxies
        ORDER BY CASE status WHEN 'alive' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                 julianday(last_success_at) DESC,
                 updated_at DESC,
                 source ASC,
                 id ASC
        LIMIT 500
      )
    `).run();

    const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    const selected = await env.DB.prepare(`
      SELECT host, port, protocol FROM proxies
      WHERE last_checked_at IS NULL OR last_checked_at < ?
      ORDER BY CASE status WHEN 'alive' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
               CASE protocol WHEN 'unknown' THEN 1 ELSE 0 END,
               COALESCE(last_checked_at, '') ASC
      LIMIT 20
    `).bind(staleBefore).all<ProxyToCheck>();

    const proxies = selected.results ?? [];
    const updates: D1PreparedStatement[] = [];
    for (let index = 0; index < proxies.length; index += 5) {
      const group = proxies.slice(index, index + 5);
      const results = await Promise.all(group.map(async (proxy) => ({
        proxy,
        result: await detectProxy(
          proxy,
          (host, port) => checkHttpProxy(host, port, dial, 3_500),
          (host, port) => checkSocks5Proxy(host, port, dial, 3_500),
        ),
      })));
      for (const { proxy, result } of results) {
        checked += 1;
        if (result.ok) alive += 1;
        const checkedAt = new Date().toISOString();
        updates.push(env.DB.prepare(`
          UPDATE proxies SET
            protocol = CASE WHEN ? = 1 THEN ? ELSE protocol END,
            status = ?, latency_ms = ?, last_checked_at = ?,
            last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
            fail_count = CASE WHEN ? = 1 THEN 0 ELSE fail_count + 1 END,
            error = ?, updated_at = ?
          WHERE id = ?
        `).bind(
          result.ok ? 1 : 0,
          result.protocol,
          result.ok ? "alive" : "dead",
          result.latencyMs,
          checkedAt,
          result.ok ? 1 : 0,
          checkedAt,
          result.ok ? 1 : 0,
          result.error,
          checkedAt,
          `${proxy.host}:${proxy.port}`,
        ));
      }
    }
    await batchStatements(env.DB, updates);
    await env.DB.prepare(
      "DELETE FROM proxies WHERE status = 'dead' AND fail_count >= 10 AND last_checked_at < datetime('now', '-7 days')",
    ).run();
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 300) : "unknown maintenance error";
  }

  await env.DB.prepare(`
    UPDATE runs SET finished_at = ?, fetched_count = ?, checked_count = ?, alive_count = ?, error = ? WHERE id = ?
  `).bind(new Date().toISOString(), fetched, checked, alive, error, runId).run();
  return { fetched, checked, alive, error };
}
