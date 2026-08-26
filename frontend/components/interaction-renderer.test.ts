import { describe, expect, it } from "vitest";
import { interactionInputValue, interactionOptions } from "../lib/interaction-values";

describe("InteractionRenderer primitives", () => {
  it("preserves numeric and boolean wire values", () => {
    expect(interactionInputValue("number", "1.5", 1.5)).toBe(1.5);
    expect(interactionInputValue("integer", "2", 2)).toBe(2);
    expect(interactionInputValue("number", "", Number.NaN)).toBe("");
    expect(interactionOptions({ type: "boolean", enum: [true, false] })).toEqual([
      { value: true, label: "true" }, { value: false, label: "false" },
    ]);
  });
});
