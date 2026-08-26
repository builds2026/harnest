import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  abandonIdempotentRun,
  acquireRunExecutionLease,
  createIdempotencyKey,
  markIdempotentRunStarted,
  readIdempotentRun,
  reserveIdempotentRun,
  releaseRunExecutionLease,
  waitForIdempotentRun,
} from "./run-idempotency";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Run create idempotency", () => {
  it("reserves before execution and returns one durable Run for concurrent retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-idempotency-"));
    directories.push(directory);
    const key = "retry/client:request-1";
    await expect(reserveIdempotentRun(directory, key, "run-first")).resolves.toMatchObject({ runId: "run-first", owner: true });
    await expect(reserveIdempotentRun(directory, key, "run-duplicate")).resolves.toMatchObject({ runId: "run-first", owner: false });
    await markIdempotentRunStarted(directory, key, "run-first");
    await expect(waitForIdempotentRun(directory, key, 100, (runId) => runId === "run-first")).resolves.toMatchObject({ runId: "run-first", state: "started" });
    await expect(readIdempotentRun(directory, key)).resolves.toMatchObject({ runId: "run-first", state: "started" });
    const files = await readdir(join(directory, ".harnest", "run-idempotency"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("request-1");
    expect(await readFile(join(directory, ".harnest", "run-idempotency", files[0]!), "utf8")).not.toContain(key);
  });

  it("recovers an orphaned reservation only when no durable Run exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-idempotency-orphan-"));
    directories.push(directory);
    const key = "retry/orphan";
    const records = join(directory, ".harnest", "run-idempotency");
    await mkdir(records, { recursive: true });
    const file = join(records, `${createHash("sha256").update(key).digest("hex")}.json`);
    await writeFile(file, `${JSON.stringify({
      version: 2, runId: "run-orphan", state: "reserved", ownerId: "dead-owner", pid: 99_999_999,
      updatedAt: new Date(0).toISOString(),
    })}\n`);
    await expect(reserveIdempotentRun(directory, key, "run-recovered", () => false)).resolves.toMatchObject({
      runId: "run-recovered", owner: true,
    });
    await abandonIdempotentRun(directory, key, "run-recovered");
    await writeFile(file, `${JSON.stringify({
      version: 2, runId: "run-durable", state: "reserved", ownerId: "dead-owner", pid: 99_999_999,
      updatedAt: new Date(0).toISOString(),
    })}\n`);
    await expect(reserveIdempotentRun(directory, key, "run-duplicate", (runId) => runId === "run-durable")).resolves.toMatchObject({
      runId: "run-durable", owner: false, state: "started",
    });
  });

  it("rejects empty, overlong, and control-character keys", () => {
    expect(createIdempotencyKey(null)).toBeUndefined();
    expect(() => createIdempotencyKey("")).toThrow();
    expect(() => createIdempotencyKey("x".repeat(513))).toThrow();
    expect(() => createIdempotencyKey("bad\nkey")).toThrow();
  });

  it("holds one execution lease per Run and takes over an orphaned process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-run-lease-"));
    directories.push(directory);
    await acquireRunExecutionLease(directory, "run-exclusive");
    await expect(acquireRunExecutionLease(directory, "run-exclusive")).rejects.toThrow(/already active/u);
    await releaseRunExecutionLease(directory, "run-exclusive");
    const leases = join(directory, ".harnest", "run-leases");
    await writeFile(join(leases, "run-orphan.json"), `${JSON.stringify({
      version: 1, runId: "run-orphan", ownerId: "dead-owner", pid: 99_999_999, createdAt: new Date(0).toISOString(),
    })}\n`);
    await expect(acquireRunExecutionLease(directory, "run-orphan")).resolves.toBeUndefined();
    await releaseRunExecutionLease(directory, "run-orphan");
  });
});
