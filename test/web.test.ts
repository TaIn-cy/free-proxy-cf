import { describe, expect, it } from "vitest";
import { isAdminAuthorized, isSameOriginMutation, renderDashboard } from "../src/web";

describe("admin web", () => {
  it("accepts only the configured Basic Auth password", async () => {
    const valid = new Request("https://example.com/admin", {
      headers: { Authorization: `Basic ${btoa("admin:correct")}` },
    });
    const invalid = new Request("https://example.com/admin", {
      headers: { Authorization: `Basic ${btoa("admin:wrong")}` },
    });
    expect(await isAdminAuthorized(valid, "correct")).toBe(true);
    expect(await isAdminAuthorized(invalid, "correct")).toBe(false);
  });

  it("renders a self-contained dashboard without embedding secrets", () => {
    const html = renderDashboard();
    expect(html).toContain("代理节点监控");
    expect(html).toContain("/api/status");
    expect(html).toContain('<option value="alive" selected>当前可用</option>');
    expect(html).not.toContain("WSAPI_KEY");
    expect(html).not.toContain("ADMIN_KEY");
  });

  it("requires same-origin proof for state-changing requests", () => {
    const valid = new Request("https://example.com/api/refresh", {
      method: "POST",
      headers: { Origin: "https://example.com", "X-Requested-With": "free-proxy-cf" },
    });
    const crossSite = new Request("https://example.com/api/refresh", {
      method: "POST",
      headers: { Origin: "https://evil.example", "X-Requested-With": "free-proxy-cf" },
    });
    expect(isSameOriginMutation(valid)).toBe(true);
    expect(isSameOriginMutation(crossSite)).toBe(false);
  });
});
