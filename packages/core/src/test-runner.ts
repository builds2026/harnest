import { Ajv2020 } from "ajv/dist/2020.js";
import type { AdapterRegistry } from "./adapter.js";
import { safeRegexTest } from "./component.js";
import { HarnessRuntime, type RunOptions, type RunResult, type RuntimeOptions } from "./runtime.js";
import type { HarnessAssertion, HarnessSpec } from "./spec.js";

export interface HarnessAssertionResult {
  type: HarnessAssertion["type"];
  ok: boolean;
  message?: string;
}

export interface HarnessTestResult {
  id: string;
  ok: boolean;
  durationMs: number;
  output?: unknown;
  assertions?: HarnessAssertionResult[];
  error?: string;
}

export interface HarnessTestReport {
  ok: boolean;
  passed: number;
  failed: number;
  cases: HarnessTestResult[];
}

export interface HarnessTestOptions extends RuntimeOptions, RunOptions {}

const comparable = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

function evaluateAssertion(assertion: HarnessAssertion, result: RunResult): HarnessAssertionResult {
  let ok = false;
  let message: string | undefined;
  if (assertion.type === "equals") ok = comparable(result.output) === assertion.value;
  else if (assertion.type === "includes") ok = comparable(result.output).includes(assertion.value);
  else if (assertion.type === "matches") ok = safeRegexTest(assertion.value, comparable(result.output));
  else if (assertion.type === "output-schema") {
    const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(assertion.schema);
    ok = Boolean(validate(result.output));
    if (!ok) message = new Ajv2020().errorsText(validate.errors);
  } else if (assertion.type === "tool-called") {
    const calls = result.trace.filter((event) => event.type === "tool-call" && event.tool === assertion.tool).length;
    const min = assertion.minCalls ?? 1;
    const max = assertion.maxCalls ?? Number.POSITIVE_INFINITY;
    ok = calls >= min && calls <= max;
    if (!ok) message = `Expected ${assertion.tool} calls in [${min}, ${String(max)}], received ${calls}`;
  } else if (assertion.type === "latency") {
    ok = result.durationMs <= assertion.maxMs;
    if (!ok) message = `Expected at most ${assertion.maxMs}ms, received ${Math.round(result.durationMs)}ms`;
  } else if (assertion.type === "iterations") {
    const min = assertion.min ?? 0;
    const max = assertion.max ?? Number.POSITIVE_INFINITY;
    ok = result.iterations >= min && result.iterations <= max;
    if (!ok) message = `Expected iterations in [${min}, ${String(max)}], received ${result.iterations}`;
  }
  return { type: assertion.type, ok, ...(message === undefined ? {} : { message }) };
}

export async function runHarnessTests(
  spec: HarnessSpec,
  registry: AdapterRegistry,
  options: HarnessTestOptions = {},
): Promise<HarnessTestReport> {
  const runtime = new HarnessRuntime(spec, registry, options);
  const cases: HarnessTestResult[] = [];
  for (const test of spec.tests ?? []) {
    const started = performance.now();
    try {
      const result = await runtime.invoke(test.input, options);
      const assertions: HarnessAssertion[] = "assertions" in test && test.assertions
        ? test.assertions
        : test.assertion ? [test.assertion] : [];
      const assertionResults = assertions.map((assertion) => evaluateAssertion(assertion, result));
      cases.push({
        id: test.id,
        ok: assertionResults.every((assertion) => assertion.ok),
        durationMs: performance.now() - started,
        output: result.output,
        assertions: assertionResults,
      });
    } catch (error) {
      cases.push({
        id: test.id,
        ok: false,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : "Test run failed",
      });
    }
  }
  const passed = cases.filter((test) => test.ok).length;
  return { ok: passed === cases.length, passed, failed: cases.length - passed, cases };
}
