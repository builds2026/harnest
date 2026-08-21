import type { Diagnostic, HarnessSpec } from "@harnest/core";
import type { NodeRuntimeServiceOptions } from "@harnest/core/node";

export interface StudioCapabilityPolicy {
  readonly allowModules: boolean;
  readonly allowFiles: boolean;
  readonly contextRoots: readonly string[];
  readonly processCommands: readonly string[];
  readonly networkHosts: readonly string[];
}

const commaList = (value: string | undefined) => value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];

export function studioCapabilityPolicy(
  env: Readonly<Record<string, string | undefined>>,
): StudioCapabilityPolicy {
  return {
    allowModules: env.HARNEST_ALLOW_MODULES === "1",
    allowFiles: env.HARNEST_ALLOW_FILES === "1",
    contextRoots: commaList(env.HARNEST_CONTEXT_ROOTS),
    processCommands: commaList(env.HARNEST_ALLOW_PROCESS),
    networkHosts: commaList(env.HARNEST_ALLOW_NETWORK).map((host) => host.toLocaleLowerCase()),
  };
}

const allComponents = (spec: HarnessSpec) => [
  ...spec.components,
  ...(spec.version === "0.2" ? Object.values(spec.subgraphs ?? {}).flatMap((graph) => graph.components) : []),
];

const configuredComponents = (spec: HarnessSpec) => [
  ...spec.components.map((component, index) => ({ component, path: `$.components[${index}]` })),
  ...(spec.version === "0.2" ? Object.entries(spec.subgraphs ?? {}).flatMap(([name, graph]) =>
    graph.components.map((component, index) => ({ component, path: `$.subgraphs.${name}.components[${index}]` }))) : []),
];

const capabilityDiagnostic = (code: string, path: string, message: string, hint: string, componentId?: string): Diagnostic => ({
  code,
  path,
  message,
  hint,
  severity: "error",
  ...(componentId ? { componentId } : {}),
});

const normalizedProjectPath = (value: string) => {
  if (/^(?:[A-Za-z]:|[\\/])/.test(value)) return undefined;
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
};

const insideConfiguredRoot = (path: string, roots: readonly string[]) => {
  const target = normalizedProjectPath(path);
  if (target === undefined) return false;
  return roots.some((root) => {
    const allowed = normalizedProjectPath(root);
    return allowed !== undefined && (allowed === "" || target === allowed || target.startsWith(`${allowed}/`));
  });
};

export function hostCapabilityDiagnosticsFor(
  spec: HarnessSpec,
  policy: StudioCapabilityPolicy,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if ((spec.runtime?.adapters?.length ?? 0) > 0 && !policy.allowModules) diagnostics.push(capabilityDiagnostic(
    "ADAPTER_MODULE_EXECUTION_DISABLED",
    "$.runtime.adapters",
    "Studio host module execution is disabled",
    "Restart the Studio host with HARNEST_ALLOW_MODULES=1 after reviewing the project",
  ));
  if (spec.version === "0.2" && (spec.runtime?.modules?.length ?? 0) > 0 && !policy.allowModules) diagnostics.push(capabilityDiagnostic(
    "RUNTIME_MODULE_EXECUTION_DISABLED",
    "$.runtime.modules",
    "Studio host runtime module execution is disabled",
    "Restart the Studio host with HARNEST_ALLOW_MODULES=1 after reviewing the project",
  ));
  for (const { component, path } of configuredComponents(spec)) {
    if (component.type === "context" && component.config.source !== "text" && typeof component.config.path === "string"
      && (!policy.allowFiles || (policy.contextRoots.length > 0 && !insideConfiguredRoot(component.config.path, policy.contextRoots)))) {
      diagnostics.push(capabilityDiagnostic(
        "HOST_FILE_CAPABILITY_DENIED",
        `${path}.config.path`,
        `File Context '${component.id}' is not allowed by the Studio host`,
        policy.allowFiles
          ? "Add a containing project-relative path to HARNEST_CONTEXT_ROOTS"
          : "Restart the Studio host with HARNEST_ALLOW_FILES=1 after reviewing the configured paths",
        component.id,
      ));
    }
    if (component.type !== "mcp-tool") continue;
    if (component.config.transport === "stdio" && typeof component.config.command === "string"
      && !policy.processCommands.includes(component.config.command)) diagnostics.push(capabilityDiagnostic(
      "HOST_PROCESS_CAPABILITY_DENIED",
      `${path}.config.command`,
      `MCP command '${component.config.command}' is not allowed by the Studio host`,
      `Add the exact command to HARNEST_ALLOW_PROCESS=${component.config.command}`,
      component.id,
    ));
    if (component.config.transport === "http" && typeof component.config.url === "string") {
      try {
        const host = new URL(component.config.url).host.toLocaleLowerCase();
        if (!policy.networkHosts.includes(host)) diagnostics.push(capabilityDiagnostic(
          "HOST_NETWORK_CAPABILITY_DENIED",
          `${path}.config.url`,
          `MCP host '${host}' is not allowed by the Studio host`,
          `Add the exact host to HARNEST_ALLOW_NETWORK=${host}`,
          component.id,
        ));
      } catch {
        // Component schema validation reports malformed URLs.
      }
    }
  }
  return diagnostics;
}

/** Keep Node capabilities scoped to resources explicitly named by the saved spec. */
export function runtimeServiceOptionsFor(
  spec: HarnessSpec,
  policy: StudioCapabilityPolicy = studioCapabilityPolicy({}),
): NodeRuntimeServiceOptions {
  const contextPaths = new Set<string>();
  const processCommands = new Set<string>();
  const networkHosts = new Set<string>();
  for (const component of allComponents(spec)) {
    if (component.type === "context" && component.config.source !== "text" && typeof component.config.path === "string") {
      contextPaths.add(component.config.path);
    }
    if (component.type !== "mcp-tool") continue;
    if (component.config.transport === "stdio" && typeof component.config.command === "string") {
      processCommands.add(component.config.command);
    }
    if (component.config.transport === "http" && typeof component.config.url === "string") {
      try {
        networkHosts.add(new URL(component.config.url).host.toLocaleLowerCase());
      } catch {
        // Config validation reports malformed URLs; permissions stay closed.
      }
    }
  }
  const allowedCommands = [...processCommands].filter((command) => policy.processCommands.includes(command));
  const allowedHosts = [...networkHosts].filter((host) => policy.networkHosts.includes(host));
  return {
    ...(policy.allowFiles && contextPaths.size
      ? { allowFileSystem: true as const, allowedContextRoots: policy.contextRoots.length ? policy.contextRoots : [...contextPaths] }
      : {}),
    ...(allowedCommands.length ? { allowProcessCommands: allowedCommands } : {}),
    ...(allowedHosts.length ? { allowNetworkHosts: allowedHosts } : {}),
  };
}
