import type { HarnessSpec } from "@harnest/core";

export const EMPTY_SPEC = {
  version: "0.2",
  components: [],
  connections: [],
  entrypoint: "",
  tests: [],
  studio: { positions: {} },
} satisfies HarnessSpec;
