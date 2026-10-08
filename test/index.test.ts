import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

let worker: (typeof import("../src/index"))["default"];
beforeAll(async () => { worker = (await import("../src/index")).default; });

const env = { ADMIN_KEY: "secret", WSAPI_KEY: "source-key", DB: {} as D1Database };
const invoke = (request: Request) => worker.fetch!(request as never, env, {} as ExecutionContext);

const adminRequest = (path: string) => new Request(`https://example.com${path}`, {
  headers: { Authorization: `Basic ${btoa("admin:secret")}` },
});

describe("worker routes", () => {
  it("protects the dashboard with Basic Auth", async () => {
    const denied = await invoke(new Request("https://example.com/admin"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");

    const allowed = await invoke(new Request("https://example.com/admin", {
      headers: { Authorization: `Basic ${btoa("admin:secret")}` },
    }));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("代理节点监控");
  });

  it("keeps the public health endpoint minimal", async () => {
    const response = await invoke(new Request("https://example.com/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns current SOCKS5 nodes as plain text for NoTrack", async () => {
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [{ host: "1.2.3.4", port: 1080 }] }; },
          async first() { return { total: 1, alive: 1, http: 0, socks5: 1 }; },
        };
      },
    } as unknown as D1Database;
    const previous = env.DB;
    env.DB = db;
    const response = await invoke(adminRequest("/socks5"));
    env.DB = previous;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("1.2.3.4:1080\n");
  });
});
