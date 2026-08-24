import { describe, expect, it } from "vitest";
import { diagnosticFieldPath, diagnosticRecoveryAction } from "./diagnostics";

describe("diagnostic recovery", () => {
  it("extracts inspector field suffixes from JSON and dot paths", () => {
    expect(diagnosticFieldPath("$.components.tool.config.tool")).toBe("tool");
    expect(diagnosticFieldPath("components[model].data.baseUrl")).toBe("baseUrl");
  });

  it("routes connection and host capability errors to direct recovery", () => {
    expect(diagnosticRecoveryAction({ code: "CONNECTION_NOT_FOUND", path: "$", message: "Missing", componentId: "model" })).toBe("connect-service");
    expect(diagnosticRecoveryAction({ code: "FILE_CAPABILITY_REQUIRED", path: "$", message: "Set HARNEST_ALLOW_FILES", componentId: "file" })).toBe("open-runtime-settings");
    expect(diagnosticRecoveryAction({ code: "COMPONENT_CONFIG_INVALID", path: "$.config.tool", message: "Invalid", componentId: "tool" })).toBe("focus-field");
  });
});
