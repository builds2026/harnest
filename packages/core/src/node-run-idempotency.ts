import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const host = globalThis as typeof globalThis & {
  __harnestRunReservationOwner?: string;
  __harnestRunExecutionLeaseCounts?: Map<string, number>;
};
const ownerId = host.__harnestRunReservationOwner ??= randomUUID();
const executionLeaseCounts = host.__harnestRunExecutionLeaseCounts ??= new Map<string, number>();

interface ReservationRecord {
  readonly version: 2;
  readonly runId: string;
  readonly state: "reserved" | "started";
  readonly ownerId: string;
  readonly pid: number;
  readonly updatedAt: string;
}

interface TakeoverRecord {
  readonly version: 1;
  readonly ownerId: string;
  readonly pid: number;
}

interface ExecutionLeaseRecord {
  readonly version: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly createdAt: string;
}

export interface RunReservation {
  readonly runId: string;
  readonly owner: boolean;
  readonly state: "reserved" | "started";
}

const recordFile = (projectDirectory: string, key: string) => join(
  projectDirectory, ".harnest", "run-idempotency",
  `${createHash("sha256").update(key).digest("hex")}.json`,
);

const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
};

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const parseRecord = (value: unknown): ReservationRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored create idempotency record is invalid");
  const record = value as Record<string, unknown>;
  if (record.version === 1 && typeof record.runId === "string" && SAFE_RUN_ID.test(record.runId)) return {
    version: 2, runId: record.runId, state: "started", ownerId: "legacy", pid: 0, updatedAt: new Date(0).toISOString(),
  };
  if (record.version !== 2 || typeof record.runId !== "string" || !SAFE_RUN_ID.test(record.runId)
    || (record.state !== "reserved" && record.state !== "started") || typeof record.ownerId !== "string"
    || typeof record.pid !== "number" || typeof record.updatedAt !== "string") {
    throw new Error("Stored create idempotency record is invalid");
  }
  return record as unknown as ReservationRecord;
};

const readRecord = async (file: string): Promise<ReservationRecord | undefined> => {
  for (let attempt = 0; ; attempt += 1) {
    try { return parseRecord(JSON.parse(await readFile(file, "utf8"))); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      if (attempt >= 4 || !(error instanceof SyntaxError)) throw error;
      await pause(5);
    }
  }
};

const atomicJsonWrite = async (file: string, value: unknown): Promise<void> => {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
};

const atomicRecordWrite = (file: string, record: ReservationRecord) => atomicJsonWrite(file, record);

const takeoverFile = (file: string, predecessor: string) =>
  `${file}.takeover.${createHash("sha256").update(predecessor).digest("hex")}`;

async function claimOrFollowTakeover(file: string, initialOwnerId: string): Promise<boolean> {
  let predecessor = initialOwnerId;
  for (let depth = 0; depth < 32; depth += 1) {
    const marker = takeoverFile(file, predecessor);
    const claim: TakeoverRecord = { version: 1, ownerId, pid: process.pid };
    try {
      await writeFile(marker, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let existing: TakeoverRecord;
      try { existing = JSON.parse(await readFile(marker, "utf8")) as TakeoverRecord; } catch (readError) {
        if (readError && typeof readError === "object" && "code" in readError && readError.code === "ENOENT") continue;
        await pause(5);
        continue;
      }
      if (existing.version !== 1 || typeof existing.ownerId !== "string" || typeof existing.pid !== "number") {
        throw new Error("Stored Run takeover record is invalid", { cause: error });
      }
      if (existing.ownerId === ownerId || processAlive(existing.pid)) return false;
      predecessor = existing.ownerId;
    }
  }
  throw new Error("Run reservation takeover chain exceeds its safety limit");
}

export async function reserveIdempotentRun(
  projectDirectory: string,
  key: string,
  proposedRunId: string = randomUUID(),
  durableRunExists?: (runId: string) => boolean | Promise<boolean>,
): Promise<RunReservation> {
  if (!SAFE_RUN_ID.test(proposedRunId)) throw new Error("Reserved Run id is invalid");
  const file = recordFile(projectDirectory, key);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const proposed: ReservationRecord = {
    version: 2, runId: proposedRunId, state: "reserved", ownerId, pid: process.pid, updatedAt: new Date().toISOString(),
  };
  try {
    await writeFile(file, `${JSON.stringify(proposed)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { runId: proposed.runId, owner: true, state: proposed.state };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const current = await readRecord(file);
  if (!current) return reserveIdempotentRun(projectDirectory, key, proposedRunId, durableRunExists);
  if (current.ownerId === "legacy" || current.ownerId === ownerId || processAlive(current.pid)) {
    return { runId: current.runId, owner: false, state: current.state };
  }
  if (durableRunExists && await durableRunExists(current.runId)) {
    await atomicRecordWrite(file, { ...current, state: "started", updatedAt: new Date().toISOString() });
    return { runId: current.runId, owner: false, state: "started" };
  }
  if (!await claimOrFollowTakeover(file, current.ownerId)) return { runId: current.runId, owner: false, state: current.state };
  const latest = await readRecord(file);
  if (!latest || latest.ownerId !== current.ownerId) {
    if (!latest) return reserveIdempotentRun(projectDirectory, key, proposedRunId, durableRunExists);
    return { runId: latest.runId, owner: latest.ownerId === ownerId, state: latest.state };
  }
  await atomicRecordWrite(file, proposed);
  return { runId: proposed.runId, owner: true, state: proposed.state };
}

export async function markIdempotentRunStarted(projectDirectory: string, key: string, runId: string): Promise<void> {
  const file = recordFile(projectDirectory, key);
  const current = await readRecord(file);
  if (!current || current.runId !== runId || current.ownerId !== ownerId) throw new Error("Run reservation ownership changed");
  await atomicRecordWrite(file, { ...current, state: "started", updatedAt: new Date().toISOString() });
}

export async function abandonIdempotentRun(projectDirectory: string, key: string, runId: string): Promise<void> {
  const file = recordFile(projectDirectory, key);
  const current = await readRecord(file);
  if (current?.runId === runId && current.ownerId === ownerId) await rm(file, { force: true });
}

export async function readIdempotentRun(projectDirectory: string, key: string): Promise<RunReservation | undefined> {
  const current = await readRecord(recordFile(projectDirectory, key));
  return current ? { runId: current.runId, owner: false, state: current.state } : undefined;
}

export async function waitForIdempotentRun(
  projectDirectory: string,
  key: string,
  timeoutMs = 5_000,
  durableRunExists?: (runId: string) => boolean | Promise<boolean>,
): Promise<RunReservation> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await readIdempotentRun(projectDirectory, key);
    if (current?.state === "started" && (!durableRunExists || await durableRunExists(current.runId))) return current;
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error("The original idempotent Run is still starting; retry this request");
}

const leaseFile = (projectDirectory: string, runId: string) =>
  join(resolve(projectDirectory), ".harnest", "run-leases", `${runId}.json`);

const readLease = async (file: string): Promise<ExecutionLeaseRecord | undefined> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as Partial<ExecutionLeaseRecord>;
      if (value.version !== 1 || typeof value.runId !== "string" || !SAFE_RUN_ID.test(value.runId)
        || typeof value.ownerId !== "string" || typeof value.pid !== "number" || typeof value.createdAt !== "string") {
        throw new Error("Stored Run execution lease is invalid");
      }
      return value as ExecutionLeaseRecord;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      if (attempt >= 4 || !(error instanceof SyntaxError)) throw error;
      await pause(5);
    }
  }
};

export async function acquireRunExecutionLease(
  projectDirectory: string,
  runId: string,
  reentrant = false,
): Promise<void> {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Run execution lease id is invalid");
  const file = leaseFile(projectDirectory, runId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lease: ExecutionLeaseRecord = {
    version: 1, runId, ownerId, pid: process.pid, createdAt: new Date().toISOString(),
  };
  try {
    await writeFile(file, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    executionLeaseCounts.set(file, 1);
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const current = await readLease(file);
  if (!current) return acquireRunExecutionLease(projectDirectory, runId, reentrant);
  if (current.ownerId === ownerId) {
    if (!reentrant) throw new Error(`Run '${runId}' is already active`);
    executionLeaseCounts.set(file, (executionLeaseCounts.get(file) ?? 1) + 1);
    return;
  }
  if (processAlive(current.pid)) throw new Error(`Run '${runId}' is already active`);
  if (!await claimOrFollowTakeover(file, current.ownerId)) throw new Error(`Run '${runId}' is already being resumed`);
  const latest = await readLease(file);
  if (!latest || latest.ownerId !== current.ownerId) throw new Error(`Run '${runId}' is already being resumed`);
  await atomicJsonWrite(file, lease);
  executionLeaseCounts.set(file, 1);
}

export async function releaseRunExecutionLease(projectDirectory: string, runId: string): Promise<void> {
  const file = leaseFile(projectDirectory, runId);
  const current = await readLease(file);
  if (current?.ownerId !== ownerId || current.runId !== runId) return;
  const count = executionLeaseCounts.get(file) ?? 1;
  if (count > 1) {
    executionLeaseCounts.set(file, count - 1);
    return;
  }
  executionLeaseCounts.delete(file);
  await rm(file, { force: true });
}
