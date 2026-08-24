import { describe, expect, it } from "vitest";
import { translate } from "./core";
import { categoryLabel, componentLabel, connectionLabel, fieldLabel } from "./manifest";

describe("manifest localization", () => {
  it("localizes built-ins and preserves plugin labels", () => {
    const t = (key: Parameters<typeof translate>[1]) => translate("ko-KR", key);
    expect(componentLabel(t, "loop", "Loop")).toBe("반복");
    expect(fieldLabel(t, "maxIterations", "Max iterations")).toBe("최대 반복 횟수");
    expect(connectionLabel(t, "tool-service")).toBe("웹 검색");
    expect(categoryLabel(t, "Knowledge")).toBe("지식");
    expect(categoryLabel(t, "Acme")).toBe("Acme");
    expect(componentLabel(t, "plugin.acme", "Acme node")).toBe("Acme node");
  });
});
