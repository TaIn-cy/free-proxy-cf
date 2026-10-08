import { describe, expect, it, vi } from "vitest";
import { collectSources, detectProxy, readResponseTextLimited, upsertCandidates } from "../src/maintenance";
import type { CheckResult } from "../src/checker";

const failed = (protocol: "http" | "socks5"): CheckResult => ({ ok: false, protocol, latencyMs: 5, error: "failed" });
const passed = (protocol: "http" | "socks5"): CheckResult => ({ ok: true, protocol, latencyMs: 12, error: null });

describe("maintenance helpers", () => {
  it("keeps the default aggregate candidate pool at five hundred", async () => {
    let sourceIndex = 0;
    const fetcher = vi.fn(async () => {
      const base = 20 + sourceIndex++;
      return new Response(Array.from({ length: 120 }, (_, index) =>
        `${base}.1.${index}.1:${2000 + index}`
      ).join("\n"));
    });
    const candidates = await collectSources("secret", fetcher, undefined, 0);
    expect(candidates).toHaveLength(500);
    expect(new Set(candidates.map((item) => item.source))).toHaveLength(5);
  });

  it("upserts one thousand candidates with only a few set-based D1 queries", async () => {
    const sql: string[] = [];
    let runs = 0;
    const db = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind() { return this; },
          async run() { runs += 1; return { success: true }; },
        };
      },
    } as unknown as D1Database;
    const candidates = Array.from({ length: 1000 }, (_, index) => ({
      host: `11.${Math.floor(index / 256)}.${index % 256}.1`,
      port: 1000 + index,
      hintedProtocol: null,
      source: "test",
    }));
    await upsertCandidates(db, candidates, "2026-01-01T00:00:00.000Z");
    expect(runs).toBeLessThanOrEqual(3);
    expect(sql.every((statement) => statement.includes("json_each"))).toBe(true);
  });

  it("stops reading a source response at the byte limit", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    }));
    await expect(readResponseTextLimited(response, 10)).rejects.toThrow("too large");
  });

  it("collects WSAPI and public sources while keeping the API key out of records", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("wsapi.top")) return new Response("1.2.3.4:80\n");
      if (url.includes("relayglass")) return new Response("9.10.11.12:1080\n");
      if (url.includes("monosans")) return new Response("5.6.7.8:1080\n");
      if (url.includes("/http/")) return new Response("13.14.15.16:8080\n");
      return new Response("17.18.19.20:1080\n");
    });
    const candidates = await collectSources("super-secret", fetcher, 10, 0);
    expect(candidates.map((item) => `${item.host}:${item.port}`)).toEqual(expect.arrayContaining([
      "1.2.3.4:80", "5.6.7.8:1080", "9.10.11.12:1080", "13.14.15.16:8080", "17.18.19.20:1080",
    ]));
    expect(candidates.find((item) => item.host === "5.6.7.8")?.hintedProtocol).toBe("socks5");
    expect(candidates.find((item) => item.host === "9.10.11.12")?.hintedProtocol).toBe("socks5");
    expect(candidates.find((item) => item.host === "13.14.15.16")?.hintedProtocol).toBe("http");
    expect(candidates.find((item) => item.host === "17.18.19.20")?.hintedProtocol).toBe("socks5");
    expect(JSON.stringify(candidates)).not.toContain("super-secret");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("falls back from HTTP to SOCKS5 when protocol is unknown", async () => {
    const http = vi.fn(async () => failed("http"));
    const socks = vi.fn(async () => passed("socks5"));
    const result = await detectProxy({ host: "1.2.3.4", port: 1080, protocol: "unknown" }, http, socks);
    expect(http).toHaveBeenCalledOnce();
    expect(socks).toHaveBeenCalledOnce();
    expect(result.protocol).toBe("socks5");
    expect(result.ok).toBe(true);
  });

  it("does not try another protocol when a hint is known", async () => {
    const http = vi.fn(async () => passed("http"));
    const socks = vi.fn(async () => failed("socks5"));
    await detectProxy({ host: "1.2.3.4", port: 1080, protocol: "socks5" }, http, socks);
    expect(http).not.toHaveBeenCalled();
    expect(socks).toHaveBeenCalledOnce();
  });
});
