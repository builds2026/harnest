import { ComponentRegistry, type ComponentManifest } from "@harnest/core";

const COLORS = ["#5967a9", "#8a6191", "#2f7480", "#ae6c2f", "#46724f", "#9a5b55"] as const;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

const hash = (value: string) => [...value].reduce((total, character) =>
  ((total << 5) - total + character.charCodeAt(0)) | 0, 0);

const pathParts = (path: string) => path
  .replace(/^\$?\.?config\.?/, "")
  .split(".")
  .filter(Boolean);

export const catalogMap = (catalog: readonly ComponentManifest[]) =>
  new Map(catalog.map((manifest) => [manifest.type, manifest]));

/**
 * Rehydrates the serializable server catalog for browser-side structural
 * validation. Executors never run in Studio; the server loads the real
 * definitions before save, test, or run.
 */
export function validationRegistryFor(catalog: readonly ComponentManifest[]) {
  const registry = new ComponentRegistry();
  for (const manifest of catalog) {
    registry.register({
      ...manifest,
      execute: () => {
        throw new Error(`Component '${manifest.type}' cannot execute in the browser`);
      },
    });
  }
  return registry;
}

export const colorFor = (value: string) => COLORS[Math.abs(hash(value)) % COLORS.length];

export const glyphFor = (label: string) => {
  const words = label.match(/[A-Za-z0-9]+/g) ?? [];
  return (words.length > 1 ? words.map((word) => word[0]).join("") : words[0]?.slice(0, 3) ?? "?")
    .toUpperCase()
    .slice(0, 3);
};

export function configValue(config: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = config;
  for (const part of pathParts(path)) {
    if (unsafeKeys.has(part) || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function withConfigValue(
  config: Readonly<Record<string, unknown>>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = pathParts(path);
  if (parts.length === 0 || parts.some((part) => unsafeKeys.has(part))) return { ...config };
  const root: Record<string, unknown> = { ...config };
  let target = root;
  for (const part of parts.slice(0, -1)) {
    const current = target[part];
    const next = current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
    target[part] = next;
    target = next;
  }
  const leaf = parts.at(-1)!;
  if (value === undefined) delete target[leaf];
  else target[leaf] = value;
  return root;
}

export function componentSummary(
  component: { config: Readonly<Record<string, unknown>> },
  manifest: ComponentManifest,
) {
  for (const field of manifest.inspector) {
    const value = configValue(component.config, field.path);
    if (typeof value === "string" && value.trim()) return value.split("\n")[0];
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return manifest.description ?? `${manifest.label} component`;
}
