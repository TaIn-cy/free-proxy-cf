import { describe, expect, it, vi } from "vitest";
import { checkHttpProxy, checkSocks5Proxy, type DialSocket } from "../src/checker";

function scriptedSocket(bytes: number[]): DialSocket {
  const writes: Uint8Array[] = [];
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({ write(chunk) { writes.push(chunk); } }),
    close: async () => {},
  };
}

describe("proxy checks", () => {
  it("accepts an HTTP proxy only after a successful forwarded response", async () => {
    const response = new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"nonce\":\"test-nonce\"}");
    const result = await checkHttpProxy("1.2.3.4", 8080, async () => scriptedSocket([...response]), 500, "test-nonce");
    expect(result.ok).toBe(true);
    expect(result.protocol).toBe("http");
  });

  it("completes SOCKS5 negotiation and verifies forwarded HTTP", async () => {
    const forwarded = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n{\"nonce\":\"test-nonce\"}");
    const response = [5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 80, ...forwarded];
    const result = await checkSocks5Proxy("1.2.3.4", 1080, async () => scriptedSocket(response), 500, "test-nonce");
    expect(result.ok).toBe(true);
    expect(result.protocol).toBe("socks5");
  });

  it("rejects a SOCKS5 server that requires unsupported authentication", async () => {
    const result = await checkSocks5Proxy("1.2.3.4", 1080, async () => scriptedSocket([5, 2]), 500);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("authentication");
  });

  it("rejects a proxy that fabricates success without echoing the nonce", async () => {
    const response = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nnot the probe response");
    const result = await checkHttpProxy("1.2.3.4", 8080, async () => scriptedSocket([...response]), 500, "test-nonce");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonce");
  });

  it("closes a stalled socket when the check times out", async () => {
    const close = vi.fn(async () => {});
    const stalled: DialSocket = {
      readable: new ReadableStream<Uint8Array>({}),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      close,
    };
    const result = await checkHttpProxy("1.2.3.4", 8080, async () => stalled, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(close).toHaveBeenCalled();
  });
});
