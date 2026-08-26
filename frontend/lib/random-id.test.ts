import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id";

describe("randomId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (values: Uint32Array) => (values.set([0, 1, 0xabcdef, 0xffffffff]), values),
    });
    expect(randomId()).toBe("000000000000000100abcdefffffffff");
  });
});
