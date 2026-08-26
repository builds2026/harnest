import {
  DiagnosticError,
  HarnessRuntime,
  HarnessSpecSchema,
  diagnosticsFromZod,
  validateSpec,
  type HarnessSpec,
} from "@harnestai/core";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "../../../lib/api-server";
import { applyExperimentVariant, experimentQuality, type ExperimentVariant } from "../../../lib/experiments";
import { hasErrors, runtimeOptionsFor, runtimeResourcesFor } from "../../../lib/server";

export const runtime = "nodejs";

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError("EXPERIMENT_INPUT_INVALID", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ApiRequestError("EXPERIMENT_INPUT_INVALID", `${name} must be 1-${max} characters`);
  }
  return value;
};

const variant = (value: unknown): ExperimentVariant => {
  const item = record(value, "Variant");
  const id = text(item.id, "Variant id", 64);
  if (!/^[\w.-]+$/.test(id)) throw new ApiRequestError("EXPERIMENT_INPUT_INVALID", "Variant id contains unsupported characters");
  return {
    id,
    label: text(item.label, "Variant label", 80),
    componentId: text(item.componentId, "Component id", 128),
    config: record(item.config, "Variant config"),
  };
};

export async function POST(request: Request) {
  let input: unknown;
  let spec: HarnessSpec;
  let variants: ExperimentVariant[];
  try {
    assertSameOrigin(request);
    const body = record(await readJsonBody(request, 2_097_152), "Experiment body");
    const parsed = HarnessSpecSchema.safeParse(body.spec);
    if (!parsed.success) return Response.json({ ok: false, diagnostics: diagnosticsFromZod(parsed.error, body.spec) }, { status: 422 });
    spec = parsed.data;
    input = body.input;
    if (!Array.isArray(body.variants) || body.variants.length < 2 || body.variants.length > 4) {
      throw new ApiRequestError("EXPERIMENT_INPUT_INVALID", "Experiments require 2-4 variants");
    }
    variants = body.variants.map(variant);
    if (new Set(variants.map(({ id }) => id)).size !== variants.length) {
      throw new ApiRequestError("EXPERIMENT_INPUT_INVALID", "Variant ids must be unique");
    }
  } catch (error) {
    return apiErrorResponse(error);
  }

  const results = [];
  for (const candidate of variants) {
    if (request.signal.aborted) break;
    let resources: Awaited<ReturnType<typeof runtimeResourcesFor>> | undefined;
    try {
      const candidateSpec = applyExperimentVariant(spec, candidate);
      resources = await runtimeResourcesFor(candidateSpec);
      const validation = validateSpec(candidateSpec, {
        registry: resources.adapters,
        components: resources.components,
        tools: resources.tools,
        env: process.env,
      });
      const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
      if (hasErrors(diagnostics)) {
        results.push({ id: candidate.id, label: candidate.label, ok: false, diagnostics });
        continue;
      }
      const result = await new HarnessRuntime(candidateSpec, resources.adapters, runtimeOptionsFor(resources))
        .invoke(input, { signal: request.signal });
      results.push({
        id: candidate.id,
        label: candidate.label,
        ok: true,
        runId: result.runId,
        output: result.output,
        durationMs: result.durationMs,
        usage: result.usage,
        costUsd: result.costUsd,
        quality: experimentQuality(result.trace),
        finishReason: result.finishReason,
      });
    } catch (error) {
      results.push({
        id: candidate.id,
        label: candidate.label,
        ok: false,
        ...(error instanceof DiagnosticError
          ? { diagnostics: error.diagnostics }
          : { error: error instanceof Error ? error.message : "Variant failed" }),
      });
    } finally {
      await resources?.services.close();
    }
  }

  return Response.json({ ok: results.length === variants.length && results.every((result) => result.ok), results });
}
