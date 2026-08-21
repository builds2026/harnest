import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

const get = (url: string, host = new URL(url).host): NextRequest => new NextRequest(url, {
  method: "GET",
  headers: { host },
});

describe("Studio request host proxy", () => {
  it("allows GET requests through literal loopback hosts", () => {
    expect(proxy(get("http://127.0.0.1:3000/api/spec")).status).toBe(200);
    expect(proxy(get("http://[::1]:3000/api/spec")).status).toBe(200);
  });

  it("rejects a DNS-rebinding GET before it reaches Studio routes", () => {
    const response = proxy(get("http://evil.test:3000/api/spec"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a loopback URL paired with a different Host header", () => {
    expect(proxy(get("http://127.0.0.1:3000/api/spec", "evil.test:3000")).status).toBe(403);
  });
});
