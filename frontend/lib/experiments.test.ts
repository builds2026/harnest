import { describe, expect, it } from "vitest";
import type { HarnessSpec } from "@harnestai/core";
import { applyExperimentVariant, experimentQuality, parseExperimentValue } from "./experiments";

describe("experiment variants", () => {
  it("overrides one component without mutating the saved harness", () => {
    const spec: HarnessSpec = {
      version: "0.2",
      components: [{ id: "model", type: "model", config: { model: "gemini-2.5-flash", temperature: 0.2 } }],
      connections: [],
      entrypoint: "model",
    };

    const changed = applyExperimentVariant(spec, {
      id: "creative",
      label: "Creative",
      componentId: "model",
      config: { temperature: 0.8 },
    });

    expect(changed.components[0]?.config).toEqual({ model: "gemini-2.5-flash", temperature: 0.8 });
    expect(spec.components[0]?.config).toEqual({ model: "gemini-2.5-flash", temperature: 0.2 });
    expect(() => applyExperimentVariant(spec, { id: "bad", label: "Bad", componentId: "missing", config: {} }))
      .toThrow("does not exist");
  });

  it("targets root and subgraph components with the same id independently", () => {
    const spec: HarnessSpec = {
      version: "0.3",
      components: [{ id: "model", type: "model", config: { model: "root", temperature: 0.2 } }],
      connections: [],
      entrypoint: "model",
      subgraphs: {
        worker: {
          components: [{ id: "model", type: "model", config: { model: "worker", temperature: 0.4 } }],
          connections: [],
          entrypoint: "model",
        },
      },
    };

    const root = applyExperimentVariant(spec, {
      id: "root",
      label: "Root",
      componentId: "model",
      config: { temperature: 0.8 },
    });
    const subgraph = applyExperimentVariant(spec, {
      id: "worker",
      label: "Worker",
      graph: "worker",
      componentId: "model",
      config: { temperature: 0.9 },
    });

    const configFor = (candidate: HarnessSpec, graph?: string) => (graph
      ? candidate.version === "0.1" ? undefined : candidate.subgraphs?.[graph]
      : candidate)?.components[0]?.config;
    expect(configFor(root)).toMatchObject({ temperature: 0.8 });
    expect(configFor(root, "worker")).toMatchObject({ temperature: 0.4 });
    expect(configFor(subgraph)).toMatchObject({ temperature: 0.2 });
    expect(configFor(subgraph, "worker")).toMatchObject({ temperature: 0.9 });
    expect(() => applyExperimentVariant(spec, {
      id: "missing",
      label: "Missing",
      graph: "missing",
      componentId: "model",
      config: {},
    })).toThrow("Graph 'missing' does not exist");
  });

  it("keeps setting value types intact", () => {
    expect(parseExperimentValue("0.7", 0.2)).toBe(0.7);
    expect(parseExperimentValue("false", true)).toBe(false);
    expect(parseExperimentValue('{"limit":5}', { limit: 2 })).toEqual({ limit: 5 });
    expect(parseExperimentValue("different prompt", "prompt")).toBe("different prompt");
    expect(() => parseExperimentValue("many", 1)).toThrow("finite number");
  });

  it("summarizes evaluator quality without inventing a score", () => {
    expect(experimentQuality([
      { type: "evaluation", runId: "run", timestamp: "2026-01-01T00:00:00.000Z", nodeId: "quality", evaluator: "quality", passed: true, score: 0.8, iteration: 0 },
      { type: "evaluation", runId: "run", timestamp: "2026-01-01T00:00:00.001Z", nodeId: "policy", evaluator: "policy", passed: false, iteration: 0 },
    ])).toEqual({ passed: 1, total: 2, averageScore: 0.8 });
    expect(experimentQuality([])).toBeUndefined();
  });
});
