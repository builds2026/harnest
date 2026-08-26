import "server-only";

import type { RunCommand, RunEvent, RunHandle, RunSnapshot } from "@harnestai/core";
import type { StoredRunEvent } from "@harnestai/core/node";

interface ActiveRun {
  readonly handle: RunHandle;
  readonly events: RunEvent[];
  readonly listeners: Set<(event?: RunEvent) => void>;
  done: boolean;
}

const MAX_ACTIVE_RUNS = 50;
const MAX_RECENT_EVENTS = 10_000;

class RunRegistry {
  readonly #runs = new Map<string, ActiveRun>();

  add(handle: RunHandle, close: () => void | Promise<void>): Promise<void> {
    if (this.#runs.get(handle.runId)?.done === false) throw new Error(`Run '${handle.runId}' is already active`);
    const active: ActiveRun = { handle, events: [], listeners: new Set(), done: false };
    this.#runs.set(handle.runId, active);
    this.#trim();
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    void (async () => {
      try {
        for await (const event of handle.events) {
          active.events.push(event);
          ready();
          if (active.events.length > MAX_RECENT_EVENTS) active.events.shift();
          for (const listener of active.listeners) listener(event);
        }
      } catch (error) {
        if (active.events.at(-1)?.type !== "error") {
          const failure: RunEvent = {
            type: "error", runId: handle.runId, timestamp: new Date().toISOString(),
            sequence: (handle.snapshot().sequence ?? 0) + 1,
            code: error && typeof error === "object" && "code" in error ? String(error.code) : "RUN_FAILED",
            message: error instanceof Error ? error.message : "Harness run failed",
          };
          active.events.push(failure);
          for (const listener of active.listeners) listener(failure);
        }
      } finally {
        ready();
        active.done = true;
        for (const listener of active.listeners) listener();
        await close();
        this.#trim();
      }
    })();
    return started;
  }

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  active(runId: string): boolean {
    const run = this.#runs.get(runId);
    return Boolean(run && !run.done);
  }

  snapshot(runId: string): RunSnapshot | undefined {
    return this.#runs.get(runId)?.handle.snapshot();
  }

  events(runId: string): readonly RunEvent[] {
    return this.#runs.get(runId)?.events ?? [];
  }

  async send(runId: string, command: RunCommand | unknown): Promise<boolean> {
    const run = this.#runs.get(runId);
    if (!run || run.done) return false;
    await run.handle.send(command);
    return true;
  }

  async cancel(runId: string): Promise<boolean> {
    const run = this.#runs.get(runId);
    if (!run || run.done) return false;
    await run.handle.cancel();
    return true;
  }

  async *stream(
    runId: string,
    after: number,
    history: readonly (StoredRunEvent | RunEvent)[],
    signal: AbortSignal,
  ): AsyncIterable<RunEvent | StoredRunEvent> {
    const run = this.#runs.get(runId);
    let cursor = after;
    const queued: Array<RunEvent | undefined> = [];
    let wake: (() => void) | undefined;
    const listener = (event?: RunEvent) => {
      queued.push(event);
      wake?.();
      wake = undefined;
    };
    run?.listeners.add(listener);
    const abort = () => listener();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const initial = [...history, ...(run?.events ?? [])]
        .filter((event) => (event.sequence ?? 0) > cursor)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
      for (const event of initial) {
        const sequence = event.sequence ?? cursor + 1;
        if (sequence <= cursor) continue;
        cursor = sequence;
        yield event;
      }
      if (!run || run.done) return;
      while (!signal.aborted) {
        if (!queued.length) await new Promise<void>((resolve) => { wake = resolve; });
        const event = queued.shift();
        if (!event) return;
        const sequence = event.sequence ?? cursor + 1;
        if (sequence <= cursor) continue;
        cursor = sequence;
        yield event;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      run?.listeners.delete(listener);
    }
  }

  #trim(): void {
    if (this.#runs.size <= MAX_ACTIVE_RUNS) return;
    for (const [runId, run] of this.#runs) {
      if (!run.done) continue;
      this.#runs.delete(runId);
      if (this.#runs.size <= MAX_ACTIVE_RUNS) break;
    }
  }
}

const host = globalThis as typeof globalThis & { __harnestRunRegistry?: RunRegistry };
export const runRegistry = host.__harnestRunRegistry ??= new RunRegistry();
