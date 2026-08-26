import "server-only";

export {
  acquireRunExecutionLease,
  abandonIdempotentRun,
  markIdempotentRunStarted,
  readIdempotentRun,
  releaseRunExecutionLease,
  reserveIdempotentRun,
  waitForIdempotentRun,
} from "@harnestai/core/node";

export function createIdempotencyKey(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (value.length > 512 || !value.length
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error("Idempotency-Key must be a bounded opaque value");
  }
  return value;
}
