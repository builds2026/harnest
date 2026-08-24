import { describe, expect, it } from "vitest";
import { formatNumber, normalizeLocale, resolveLocale, translate } from "./core";

describe("Studio locale", () => {
  it("prefers a saved supported locale and detects browser language otherwise", () => {
    expect(resolveLocale("en-US", "ko-KR,ko;q=0.9")).toBe("en-US");
    expect(resolveLocale(undefined, "ko-KR,ko;q=0.9,en;q=0.8")).toBe("ko-KR");
    expect(resolveLocale(undefined, "fr-FR")).toBe("en-US");
    expect(normalizeLocale("KO-kr")).toBe("ko-KR");
  });

  it("interpolates messages and formats numbers with the active locale", () => {
    expect(translate("ko-KR", "save.issues", { count: 3 })).toBe("문제 3개");
    expect(formatNumber("en-US", 12_345)).toBe("12,345");
    expect(formatNumber("ko-KR", 12_345)).toBe("12,345");
  });
});
