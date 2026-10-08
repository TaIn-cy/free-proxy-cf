import { describe, expect, it } from "vitest";
import { parseProxyText } from "../src/core";

describe("parseProxyText", () => {
  it("extracts valid unique IPv4 host-port pairs and skips headings", () => {
    const input = [
      "请勿用于非法",
      "上次更新时间：10-08 00:00:01",
      "23.122.184.9:8888",
      "23.122.184.9:8888",
      "socks5://103.154.230.97:5678",
      "999.1.1.1:80",
      "127.0.0.1:8080",
      "not-a-proxy",
    ].join("\n");

    expect(parseProxyText(input, "wsapi")).toEqual([
      { host: "23.122.184.9", port: 8888, hintedProtocol: null, source: "wsapi" },
      { host: "103.154.230.97", port: 5678, hintedProtocol: "socks5", source: "wsapi" },
    ]);
  });
});
