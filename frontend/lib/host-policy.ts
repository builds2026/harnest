import type { Diagnostic, HarnessSpec } from "@harnestai/core/browser";

export interface StudioCapabilityPolicy {
  readonly allowModules: boolean;
  readonly allowFiles: boolean;
  readonly contextRoots: readonly string[];
  readonly processCommands: readonly string[];
  readonly networkHosts: readonly string[];
  readonly approvedToolIds: readonly string[];
}

const hostDiagnosticCodes = new Set([
  "ADAPTER_MODULE_EXECUTION_DISABLED",
  "RUNTIME_MODULE_EXECUTION_DISABLED",
  "HOST_FILE_CAPABILITY_DENIED",
  "HOST_PROCESS_CAPABILITY_DENIED",
  "HOST_NETWORK_CAPABILITY_DENIED",
]);

export const isHostCapabilityDiagnostic = (diagnostic: Diagnostic) => hostDiagnosticCodes.has(diagnostic.code);

const quote = (value: string) => /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const unique = (values: Iterable<string>) => [...new Set(values)].filter(Boolean);
const components = (spec: HarnessSpec) => [
  ...spec.components,
  ...(spec.version === "0.1" ? [] : Object.values(spec.subgraphs ?? {}).flatMap((graph) => graph.components)),
];

export function studioRestartCommand(
  file: string,
  port: string,
  spec: HarnessSpec,
  policy: StudioCapabilityPolicy,
): string {
  const configured = components(spec);
  const contextRoots = unique([
    ...policy.contextRoots,
    ...configured.flatMap((component) => component.type === "context" && component.config.source !== "text"
      && typeof component.config.path === "string" ? [component.config.path] : []),
  ]);
  const processCommands = unique([
    ...policy.processCommands,
    ...configured.flatMap((component) => component.type === "mcp-tool" && component.config.transport === "stdio"
      && typeof component.config.command === "string" ? [component.config.command] : []),
  ]);
  const networkHosts = unique([
    ...policy.networkHosts,
    ...configured.flatMap((component) => {
      if (component.type !== "mcp-tool" || component.config.transport !== "http" || typeof component.config.url !== "string") return [];
      try { return [new URL(component.config.url).host.toLocaleLowerCase()]; } catch { return []; }
    }),
  ]);
  const needsModules = policy.allowModules || (spec.runtime?.adapters?.length ?? 0) > 0
    || (spec.version !== "0.1" && (spec.runtime?.modules?.length ?? 0) > 0);
  const args = ["harnest", "studio", file, "--port", port];
  if (needsModules) args.push("--allow-modules");
  if (policy.allowFiles || contextRoots.length) args.push("--allow-files");
  for (const root of contextRoots) args.push("--context-root", root);
  for (const command of processCommands) args.push("--allow-process", command);
  for (const host of networkHosts) args.push("--allow-network", host);
  for (const tool of unique(policy.approvedToolIds)) args.push("--approve-tool", tool);
  return args.map(quote).join(" ");
}
