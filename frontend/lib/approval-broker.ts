import "server-only";

import { createHash } from "node:crypto";
import type { ToolApprovalDecision, ToolApprovalRequest } from "@harnest/core";

export interface PendingApprovalView {
  readonly runId: string;
  readonly nodeId: string;
  readonly callId: string;
  readonly turn: number;
  readonly tool: string;
  readonly risk: string;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly inputBytes: number;
  readonly previewLimited: boolean;
}

interface PendingApproval {
  readonly resolve: (decision: ToolApprovalDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly view: PendingApprovalView;
}

const approvalKey = (runId: string, nodeId: string, turn: number, callId: string) =>
  `${runId}\u0000${nodeId}\u0000${turn}\u0000${callId}`;

function approvalPreview(value: unknown, key = "", depth = 0): { value: unknown; limited: boolean } {
  if (/(?:api[-_]?key|authorization|secret|token|pass(?:word|phrase)|credentials?|cookies?|private[-_]?key)$/i.test(key)) {
    return { value: "[REDACTED]", limited: true };
  }
  if (typeof value === "string") return value.length > 4_000
    ? { value: `${value.slice(0, 4_000)}…[truncated]`, limited: true }
    : { value, limited: false };
  if (value === null || typeof value !== "object") return { value, limited: false };
  if (depth >= 8) return { value: "[truncated]", limited: true };
  if (Array.isArray(value)) {
    const previews = value.slice(0, 100).map((item) => approvalPreview(item, "", depth + 1));
    return { value: previews.map((item) => item.value), limited: value.length > 100 || previews.some((item) => item.limited) };
  }
  const entries = Object.entries(value);
  let limited = entries.length > 100;
  const result: Record<string, unknown> = {};
  for (const [name, item] of entries.slice(0, 100)) {
    const preview = approvalPreview(item, name, depth + 1);
    result[name] = preview.value;
    limited ||= preview.limited;
  }
  return { value: result, limited };
}

class ApprovalBroker {
  readonly #pending = new Map<string, PendingApproval>();

  request(request: ToolApprovalRequest, signal: AbortSignal): Promise<ToolApprovalDecision> {
    const key = approvalKey(request.runId, request.nodeId, request.turn, request.callId);
    this.#finish(key, { approved: false, source: "policy", reason: "Superseded duplicate approval request" });
    const serialized = JSON.stringify(request.input);
    const preview = approvalPreview(request.input);
    const view: PendingApprovalView = {
      runId: request.runId,
      nodeId: request.nodeId,
      callId: request.callId,
      turn: request.turn,
      tool: request.tool.id,
      risk: request.tool.risk ?? "external",
      input: preview.value,
      inputDigest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
      inputBytes: Buffer.byteLength(serialized),
      previewLimited: preview.limited,
    };
    return new Promise<ToolApprovalDecision>((resolve) => {
      const abort = () => this.#finish(key, { approved: false, source: "policy", reason: "Run cancelled" });
      const timer = setTimeout(() => {
        this.#finish(key, { approved: false, source: "policy", reason: "Approval timed out" });
      }, 120_000);
      this.#pending.set(key, { resolve, timer, signal, abort, view });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  pending(runId: string, nodeId: string, turn: number, callId: string): PendingApprovalView | undefined {
    const pending = this.#pending.get(approvalKey(runId, nodeId, turn, callId));
    return pending ? structuredClone(pending.view) : undefined;
  }

  decide(runId: string, nodeId: string, turn: number, callId: string, inputDigest: string, approved: boolean): boolean {
    const key = approvalKey(runId, nodeId, turn, callId);
    const pending = this.#pending.get(key);
    if (pending?.view.inputDigest !== inputDigest || (approved && pending.view.previewLimited)) return false;
    return this.#finish(key, {
      approved,
      source: "user",
      ...(!approved ? { reason: "Denied by the Studio operator" } : {}),
    });
  }

  #finish(key: string, decision: ToolApprovalDecision): boolean {
    const pending = this.#pending.get(key);
    if (!pending) return false;
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(decision);
    return true;
  }
}

// ponytail: process-local approvals are sufficient while Studio is a single local Next process.
const brokerGlobal = globalThis as typeof globalThis & { __harnestApprovalBroker?: ApprovalBroker };
export const approvalBroker = brokerGlobal.__harnestApprovalBroker ??= new ApprovalBroker();
