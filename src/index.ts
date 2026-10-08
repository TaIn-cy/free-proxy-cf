import { connect } from "cloudflare:sockets";
import type { DialSocket } from "./checker";
import { runMaintenance, type MaintenanceEnv } from "./maintenance";
import { isAdminAuthorized, isSameOriginMutation, renderDashboard, unauthorized } from "./web";

export interface Env extends MaintenanceEnv {
  ADMIN_KEY: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function acquireLock(db: D1Database): Promise<string | null> {
  const now = Date.now();
  const owner = crypto.randomUUID();
  const result = await db.prepare(
    "UPDATE runtime_lock SET locked_until = ?, owner = ? WHERE id = 1 AND locked_until < ?",
  ).bind(now + 9 * 60_000, owner, now).run();
  return (result.meta.changes ?? 0) === 1 ? owner : null;
}

async function maintenance(env: Env): Promise<void> {
  const owner = await acquireLock(env.DB);
  if (!owner) return;
  try {
    await runMaintenance(env, (host, port) => connect(
      { hostname: host, port },
      { allowHalfOpen: false, secureTransport: "off" },
    ) as unknown as DialSocket);
  } finally {
    await env.DB.prepare(
      "UPDATE runtime_lock SET locked_until = 0, owner = NULL WHERE id = 1 AND owner = ?",
    ).bind(owner).run();
  }
}

async function statusResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requested = url.searchParams.get("status") ?? "all";
  const status = ["alive", "dead", "pending"].includes(requested) ? requested : "all";
  const summary = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'alive' AND julianday(last_success_at) >= julianday('now', '-45 minutes') THEN 1 ELSE 0 END) AS alive,
      SUM(CASE WHEN protocol = 'http' AND status = 'alive' AND julianday(last_success_at) >= julianday('now', '-45 minutes') THEN 1 ELSE 0 END) AS http,
      SUM(CASE WHEN protocol = 'socks5' AND status = 'alive' AND julianday(last_success_at) >= julianday('now', '-45 minutes') THEN 1 ELSE 0 END) AS socks5
    FROM proxies
  `).first<Record<string, number | null>>();
  const query = status === "all"
    ? "SELECT host, port, protocol, source, status, latency_ms, last_success_at, fail_count FROM proxies ORDER BY CASE status WHEN 'alive' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, latency_ms ASC LIMIT 300"
    : status === "alive"
      ? "SELECT host, port, protocol, source, status, latency_ms, last_success_at, fail_count FROM proxies WHERE status = 'alive' AND julianday(last_success_at) >= julianday('now', '-45 minutes') ORDER BY latency_ms ASC LIMIT 300"
      : "SELECT host, port, protocol, source, status, latency_ms, last_success_at, fail_count FROM proxies WHERE status = ? ORDER BY latency_ms ASC LIMIT 300";
  const prepared = env.DB.prepare(query);
  const proxies = status === "all" || status === "alive" ? await prepared.all() : await prepared.bind(status).all();
  const latestRun = await env.DB.prepare(
    "SELECT started_at, finished_at, fetched_count, checked_count, alive_count, error FROM runs ORDER BY started_at DESC LIMIT 1",
  ).first();
  return json({
    summary: {
      total: Number(summary?.total ?? 0),
      alive: Number(summary?.alive ?? 0),
      http: Number(summary?.http ?? 0),
      socks5: Number(summary?.socks5 ?? 0),
    },
    proxies: proxies.results ?? [],
    latestRun,
  });
}

async function proxyListResponse(env: Env, protocol: "http" | "socks5"): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT host, port FROM proxies
    WHERE protocol = ?
      AND status = 'alive'
      AND julianday(last_success_at) >= julianday('now', '-45 minutes')
    ORDER BY latency_ms ASC, last_success_at DESC
    LIMIT 500
  `).bind(protocol).all<{ host: string; port: number }>();
  const body = (result.results ?? []).map((proxy) => `${proxy.host}:${proxy.port}`).join("\n");
  return new Response(body ? `${body}\n` : "", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/") return Response.redirect(`${url.origin}/admin`, 302);

    if (!(await isAdminAuthorized(request, env.ADMIN_KEY))) return unauthorized();
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(renderDashboard(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      try {
        return await statusResponse(request, env);
      } catch {
        return json({ error: "database query failed" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/socks5") {
      try {
        return await proxyListResponse(env, "socks5");
      } catch {
        return json({ error: "database query failed" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/http") {
      try {
        return await proxyListResponse(env, "http");
      } catch {
        return json({ error: "database query failed" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      if (!isSameOriginMutation(request)) return json({ error: "same-origin request required" }, 403);
      ctx.waitUntil(maintenance(env));
      return json({ accepted: true }, 202);
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(maintenance(env));
  },
};

export default worker;
