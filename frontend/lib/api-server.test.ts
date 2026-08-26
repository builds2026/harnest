import { describe, expect, it, vi } from "vitest";
import { SkillParseError } from "@harnestai/core";

vi.mock("server-only", () => ({}));

import { apiErrorResponse, assertSameOrigin } from "./api-server";

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
      "Request host must be an allowed Studio address matching this Studio",
    );
    expect(() => assertSameOrigin(requestFrom("localhost:3000"))).toThrowError(
      "Request host must be an allowed Studio address matching this Studio",
    );
  });

  it("accepts only explicitly configured remote Studio hosts", () => {
    const previous = process.env.HARNEST_STUDIO_ALLOWED_HOSTS;
    const previousBind = process.env.HARNEST_STUDIO_HOST;
    process.env.HARNEST_STUDIO_ALLOWED_HOSTS = "100.79.184.36";
    process.env.HARNEST_STUDIO_HOST = "0.0.0.0";
    try {
      expect(() => assertSameOrigin(requestFrom("100.79.184.36:3000"))).not.toThrow();
      expect(() => assertSameOrigin(new Request("http://0.0.0.0:3000/api/run", {
        method: "POST",
        headers: { host: "100.79.184.36:3000", origin: "http://100.79.184.36:3000" },
      }))).not.toThrow();
      expect(() => assertSameOrigin(requestFrom("100.79.184.37:3000"))).toThrow();
    } finally {
      if (previous === undefined) delete process.env.HARNEST_STUDIO_ALLOWED_HOSTS;
      else process.env.HARNEST_STUDIO_ALLOWED_HOSTS = previous;
      if (previousBind === undefined) delete process.env.HARNEST_STUDIO_HOST;
      else process.env.HARNEST_STUDIO_HOST = previousBind;
    }
  });

  it("returns actionable Skill parser errors", async () => {
    const response = apiErrorResponse(new SkillParseError(
      "SKILL_NAME_MISMATCH",
      "Skill name 'demo' does not match its directory 'other'",
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SKILL_NAME_MISMATCH", message: "Skill name 'demo' does not match its directory 'other'" },
    });
  });
});
