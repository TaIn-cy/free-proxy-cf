import type { ProxyProtocol } from "./core";

export interface DialSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void | Promise<void>;
}

export type Dial = (host: string, port: number) => Promise<DialSocket> | DialSocket;

export interface CheckResult {
  ok: boolean;
  protocol: ProxyProtocol;
  latencyMs: number;
  error: string | null;
}

const encoder = new TextEncoder();

class ByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async exact(size: number): Promise<Uint8Array> {
    while (this.buffer.length < size) {
      const next = await this.reader.read();
      if (next.done || !next.value) throw new Error("unexpected EOF");
      const merged = new Uint8Array(this.buffer.length + next.value.length);
      merged.set(this.buffer);
      merged.set(next.value, this.buffer.length);
      this.buffer = merged;
    }
    const value = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return value;
  }

  async line(max = 4096): Promise<string> {
    while (true) {
      for (let index = 0; index < this.buffer.length - 1; index += 1) {
        if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
          const value = new TextDecoder().decode(this.buffer.slice(0, index));
          this.buffer = this.buffer.slice(index + 2);
          return value;
        }
      }
      if (this.buffer.length >= max) throw new Error("response line too long");
      const next = await this.reader.read();
      if (next.done || !next.value) throw new Error("unexpected EOF");
      const merged = new Uint8Array(this.buffer.length + next.value.length);
      merged.set(this.buffer);
      merged.set(next.value, this.buffer.length);
      this.buffer = merged;
    }
  }

  async rest(max = 65_536): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = this.buffer.length;
    if (this.buffer.length > 0) chunks.push(this.buffer);
    this.buffer = new Uint8Array(0);
    while (true) {
      const next = await this.reader.read();
      if (next.done || !next.value) break;
      size += next.value.length;
      if (size > max) throw new Error("probe response too large");
      chunks.push(next.value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(merged);
  }

  release(): void {
    this.reader.releaseLock();
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validStatus(line: string): boolean {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(line);
  if (!match) return false;
  return Number(match[1]) === 200;
}

async function write(socket: DialSocket, bytes: Uint8Array): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

async function performHttpCheck(socket: DialSocket, nonce: string): Promise<void> {
  const reader = new ByteReader(socket.readable);
  try {
    await write(socket, encoder.encode(
      `GET http://httpbingo.org/get?nonce=${encodeURIComponent(nonce)} HTTP/1.1\r\n` +
      "Host: httpbingo.org\r\nConnection: close\r\nUser-Agent: free-proxy-cf/1\r\n\r\n",
    ));
    const statusLine = await reader.line();
    if (!validStatus(statusLine)) throw new Error(`forwarded request failed: ${statusLine.slice(0, 80)}`);
    if (!(await reader.rest()).includes(nonce)) throw new Error("probe response did not echo nonce");
  } finally {
    reader.release();
    await socket.close();
  }
}

async function performSocks5Check(socket: DialSocket, nonce: string): Promise<void> {
  const reader = new ByteReader(socket.readable);
  try {
    await write(socket, new Uint8Array([5, 1, 0]));
    const method = await reader.exact(2);
    if (method[0] !== 5) throw new Error("invalid SOCKS5 version");
    if (method[1] !== 0) throw new Error("SOCKS5 proxy requires unsupported authentication");

    const target = encoder.encode("httpbingo.org");
    await write(socket, new Uint8Array([5, 1, 0, 3, target.length, ...target, 0, 80]));
    const reply = await reader.exact(4);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 connect failed (${reply[1]})`);
    if (reply[3] === 1) await reader.exact(4);
    else if (reply[3] === 4) await reader.exact(16);
    else if (reply[3] === 3) await reader.exact((await reader.exact(1))[0]);
    else throw new Error("invalid SOCKS5 address type");
    await reader.exact(2);

    await write(socket, encoder.encode(
      `GET /get?nonce=${encodeURIComponent(nonce)} HTTP/1.1\r\nHost: httpbingo.org\r\nConnection: close\r\nUser-Agent: free-proxy-cf/1\r\n\r\n`,
    ));
    const statusLine = await reader.line();
    if (!validStatus(statusLine)) throw new Error(`forwarded request failed: ${statusLine.slice(0, 80)}`);
    if (!(await reader.rest()).includes(nonce)) throw new Error("probe response did not echo nonce");
  } finally {
    reader.release();
    await socket.close();
  }
}

async function runCheck(
  protocol: ProxyProtocol,
  host: string,
  port: number,
  dial: Dial,
  timeoutMs: number,
  nonce: string,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    const socket = await withTimeout(Promise.resolve(dial(host, port)), timeoutMs);
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    await withTimeout(
      protocol === "http" ? performHttpCheck(socket, nonce) : performSocks5Check(socket, nonce),
      remaining,
      () => { void socket.close(); },
    );
    return { ok: true, protocol, latencyMs: Date.now() - started, error: null };
  } catch (caught) {
    return {
      ok: false,
      protocol,
      latencyMs: Date.now() - started,
      error: caught instanceof Error ? caught.message.slice(0, 160) : "unknown error",
    };
  }
}

export function checkHttpProxy(
  host: string,
  port: number,
  dial: Dial,
  timeoutMs = 5000,
  nonce: string = crypto.randomUUID(),
): Promise<CheckResult> {
  return runCheck("http", host, port, dial, timeoutMs, nonce);
}

export function checkSocks5Proxy(
  host: string,
  port: number,
  dial: Dial,
  timeoutMs = 5000,
  nonce: string = crypto.randomUUID(),
): Promise<CheckResult> {
  return runCheck("socks5", host, port, dial, timeoutMs, nonce);
}
