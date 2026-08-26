import type { HarnessSpec } from "@harnestai/core";

export const EMPTY_SPEC = {
  version: "0.2",
  components: [],
  connections: [],
  entrypoint: "",
  tests: [],
  studio: { positions: {} },
} satisfies HarnessSpec;
