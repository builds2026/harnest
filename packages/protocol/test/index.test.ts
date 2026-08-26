import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  RunCommandSchema,
  CreateRunRequestSchema,
  IdempotencyKeySchema,
  InteractionRequestSchema,
  PermissionSchema,
  SnapshotResponseSchema,
  WireEnvelopeSchema,
  commandJsonSchema,
  idempotencyKeyJsonSchema,
  protocolJsonSchema,
  toWireEvent,
} from "../src/index";

describe("Harnest protocol v1", () => {
  it("accepts the language-independent golden messages", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/v1.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(IdempotencyKeySchema.parse(fixture.idempotencyKey)).toBe(fixture.idempotencyKey);
    expect(CreateRunRequestSchema.parse(fixture.createRun)).toEqual(fixture.createRun);
    expect(SnapshotResponseSchema.parse(fixture.snapshotResponse)).toEqual(fixture.snapshotResponse);
    expect(WireEnvelopeSchema.parse(fixture.event)).toEqual(fixture.event);
    expect(RunCommandSchema.parse(fixture.command)).toEqual(fixture.command);
    expect(InteractionRequestSchema.parse(fixture.interaction)).toEqual(fixture.interaction);
    expect(InteractionRequestSchema.parse({
      ...fixture.interaction as object,
      nodeId: "team/research:agent",
      requester: { kind: "mcp", id: "server/tools:lookup" },
    })).toMatchObject({ nodeId: "team/research:agent" });
    expect(PermissionSchema.parse(fixture.permission)).toEqual(fixture.permission);
  });

  it("exports draft 2020-12 JSON Schemas and rejects incompatible versions", () => {
    expect(protocolJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(commandJsonSchema.oneOf).toHaveLength(5);
    expect(idempotencyKeyJsonSchema.maxLength).toBe(512);
    expect(() => WireEnvelopeSchema.parse({ protocolVersion: "2", type: "run.started" })).toThrow();
    const fixture = {
      protocolVersion: "1.9", eventId: "event-1", runId: "run-1", sequence: 1,
      time: "2026-08-25T00:00:00.000Z", type: "run.started", data: {}, additive: true,
    };
    expect(WireEnvelopeSchema.parse(fixture)).toEqual(fixture);
    expect(() => WireEnvelopeSchema.parse({ ...fixture, protocolVersion: "2.0" })).toThrow();
  });

  it("rejects identity and credential fields from create context", () => {
    const base = { input: "hello", context: { contextRef: "opaque" } };
    for (const field of ["userId", "conversationId", "secret", "token"] as const) {
      expect(CreateRunRequestSchema.safeParse({
        ...base, context: { ...base.context, [field]: "must-not-cross" },
      }).success).toBe(false);
    }
    expect(IdempotencyKeySchema.safeParse("").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("bad\nkey").success).toBe(false);
  });

  it("maps internal kebab event names to stable dotted wire names", () => {
    expect(toWireEvent({
      type: "run-paused", runId: "run-1", timestamp: "2026-08-25T00:00:00.000Z", sequence: 8, paused: true,
    })).toMatchObject({ protocolVersion: "1.0", eventId: "run-1.8", type: "run.paused" });
    expect(toWireEvent({
      type: "error", runId: "run-1", timestamp: "2026-08-25T00:00:00.000Z", sequence: 9,
      code: "RUN_CANCELLED", message: "cancelled",
    })).toMatchObject({ type: "run.cancelled" });
  });
});
