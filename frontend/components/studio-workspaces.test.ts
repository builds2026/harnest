import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@harnestai/core";

vi.mock("@/lib/api-client", () => ({ apiErrorMessage: () => "error", requestJson: async () => ({}) }));
vi.mock("@/lib/connections", () => ({ connectionCanRun: () => false }));
vi.mock("@/i18n/manifest", () => ({ connectionLabel: () => "connection" }));
vi.mock("@/lib/trace-view", () => ({ groupTraceEvents: () => [] }));
vi.mock("./i18n-provider", () => ({ useI18n: () => ({}) }));

import { filterStoredRuns, runSelectionUrl, serializeRunTrace, type StoredRun } from "./studio-workspaces";

const runs: StoredRun[] = [
  { runId: "run_alpha", status: "succeeded" },
  { runId: "run_beta", status: "failed" },
  { runId: "RUN_GAMMA" },
];

describe("Runs workspace helpers", () => {
  it("filters runs by status and case-insensitive ID or status search", () => {
    expect(filterStoredRuns(runs, "BETA", "all").map(({ runId }) => runId)).toEqual(["run_beta"]);
    expect(filterStoredRuns(runs, "fail", "failed").map(({ runId }) => runId)).toEqual(["run_beta"]);
    expect(filterStoredRuns(runs, "run", "unknown").map(({ runId }) => runId)).toEqual(["RUN_GAMMA"]);
  });

  it("serializes a portable trace envelope", () => {
    const event = {
      type: "error", runId: "run_beta", timestamp: "2026-08-27T00:00:00.000Z",
      sequence: 1, code: "FIXTURE", message: "failed",
    } satisfies RunEvent;
    expect(JSON.parse(serializeRunTrace("run_beta", [event]))).toEqual({
      version: 1,
      runId: "run_beta",
      eventCount: 1,
      events: [event],
    });
  });

  it("adds, replaces, and removes the selected run query without losing other URL state", () => {
    expect(runSelectionUrl("https://studio.test/runs?view=compact#trace", "run_alpha"))
      .toBe("/runs?view=compact&runId=run_alpha#trace");
    expect(runSelectionUrl("https://studio.test/runs?runId=old&view=compact#trace", "run_beta"))
      .toBe("/runs?runId=run_beta&view=compact#trace");
    expect(runSelectionUrl("https://studio.test/runs?runId=old&view=compact#trace"))
      .toBe("/runs?view=compact#trace");
  });
});
