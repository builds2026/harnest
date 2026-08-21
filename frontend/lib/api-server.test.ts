import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertSameOrigin } from "./api-server";

const requestFrom = (host: string, origin = `http://${host}`): Request => new Request(
  `http://${host}/api/run`,
  { method: "POST", headers: { host, origin } },
);

describe("Studio API same-origin guard", () => {
  it("accepts literal IPv4 and IPv6 loopback origins", () => {
    expect(() => assertSameOrigin(requestFrom("127.0.0.1:3000"))).not.toThrow();
    expect(() => assertSameOrigin(requestFrom("[::1]:3000"))).not.toThrow();
  });

  it("rejects matching DNS host and Origin values", () => {
    expect(() => assertSameOrigin(requestFrom("evil.test:3000"))).toThrowError(
      "Request host must be a literal loopback address matching this Studio",
    );
    expect(() => assertSameOrigin(requestFrom("localhost:3000"))).toThrowError(
      "Request host must be a literal loopback address matching this Studio",
    );
  });
});
