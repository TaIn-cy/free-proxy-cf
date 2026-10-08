export type ProxyProtocol = "http" | "socks5";

export interface ProxyCandidate {
  host: string;
  port: number;
  hintedProtocol: ProxyProtocol | null;
  source: string;
}

function validPublicIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((value, index) => !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== parts[index])) {
    return false;
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

export function parseProxyText(text: string, source: string): ProxyCandidate[] {
  const results: ProxyCandidate[] = [];
  const seen = new Set<string>();
  const pattern = /(?:(https?|socks5):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/gi;
  for (const match of text.matchAll(pattern)) {
    const host = match[2];
    const port = Number(match[3]);
    if (!validPublicIpv4(host) || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    const hintedProtocol = match[1]?.toLowerCase() === "socks5" ? "socks5" : match[1] ? "http" : null;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ host, port, hintedProtocol, source });
  }
  return results;
}
