import type { HarnessSpec } from "@harnest/core";

export const EMPTY_SPEC = {
  version: "0.2",
  components: [],
  connections: [],
  entrypoint: "",
  runtime: { adapters: ["@harnest/adapter-local"] },
  tests: [],
  studio: { positions: {} },
} satisfies HarnessSpec;
