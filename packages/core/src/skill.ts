import { parseDocument } from "yaml";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillRequirementKind = "tools" | "connections" | "permissions";

export interface SkillRequirements {
  readonly tools: readonly string[];
  readonly connections: readonly string[];
  readonly permissions: readonly string[];
}

export type SkillConnectionKind = "provider" | "mcp-http" | "mcp-stdio" | "http-api" | "tool-service" | "local-runtime";

const SKILL_CONNECTION_KINDS: readonly SkillConnectionKind[] = [
  "provider", "mcp-http", "mcp-stdio", "http-api", "tool-service", "local-runtime",
];

/** Accepts `kind:id`; legacy ids such as `local-runtime-main` retain their full id and infer the wizard kind. */
export function skillConnectionRequirement(value: string): { readonly id: string; readonly kind?: SkillConnectionKind } {
  const explicit = SKILL_CONNECTION_KINDS.find((kind) => value.startsWith(`${kind}:`) && value.length > kind.length + 1);
  if (explicit) return { id: value.slice(explicit.length + 1), kind: explicit };
  const inferred = SKILL_CONNECTION_KINDS.find((kind) => value.startsWith(`${kind}-`));
  return { id: value, ...(inferred ? { kind: inferred } : {}) };
}

/** Public Agent Skills frontmatter plus Harnest's namespaced metadata extension. */
export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
  readonly requirements: SkillRequirements;
}

export interface ParsedSkillDocument {
  readonly descriptor: SkillDescriptor;
  readonly body: string;
}

export type SkillParseErrorCode =
  | "SKILL_FRONTMATTER_MISSING"
  | "SKILL_FRONTMATTER_INVALID"
  | "SKILL_NAME_INVALID"
  | "SKILL_NAME_MISMATCH"
  | "SKILL_DESCRIPTION_INVALID"
  | "SKILL_FIELD_INVALID"
  | "SKILL_METADATA_INVALID"
  | "SKILL_REQUIREMENT_INVALID";

export class SkillParseError extends Error {
  readonly code: SkillParseErrorCode;
  readonly field?: string;

  constructor(code: SkillParseErrorCode, message: string, field?: string) {
    super(message);
    this.name = "SkillParseError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

export interface ParseSkillOptions {
  /** The containing folder name. The public format requires this to match `name`. */
  readonly directoryName?: string;
}

interface FrontmatterSlice {
  readonly yaml: string;
  readonly body: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/** Split without interpreting the Markdown body. Delimiters must occupy their own lines. */
export function splitSkillDocument(source: string): FrontmatterSlice {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const firstLineEnd = normalized.indexOf("\n");
  const firstLine = (firstLineEnd < 0 ? normalized : normalized.slice(0, firstLineEnd)).replace(/\r$/, "");
  if (firstLine !== "---") {
    throw new SkillParseError(
      "SKILL_FRONTMATTER_MISSING",
      "SKILL.md must begin with a YAML frontmatter delimiter",
    );
  }
  let offset = firstLineEnd + 1;
  while (offset > 0 && offset <= normalized.length) {
    const lineEnd = normalized.indexOf("\n", offset);
    const end = lineEnd < 0 ? normalized.length : lineEnd;
    const line = normalized.slice(offset, end).replace(/\r$/, "");
    if (line === "---") {
      return {
        yaml: normalized.slice(firstLineEnd + 1, offset),
        body: lineEnd < 0 ? "" : normalized.slice(lineEnd + 1),
      };
    }
    if (lineEnd < 0) break;
    offset = lineEnd + 1;
  }
  throw new SkillParseError(
    "SKILL_FRONTMATTER_MISSING",
    "SKILL.md frontmatter has no closing delimiter",
  );
}

const requiredString = (
  record: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  code: SkillParseErrorCode,
): string => {
  const value = record[field];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new SkillParseError(
      code,
      `Skill '${field}' must be a string between ${minimum} and ${maximum} characters`,
      field,
    );
  }
  return value;
};

const optionalString = (
  record: Record<string, unknown>,
  field: string,
  maximum?: number,
): string | undefined => {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || (maximum !== undefined && value.length > maximum)) {
    throw new SkillParseError(
      "SKILL_FIELD_INVALID",
      `Skill '${field}' must be a non-empty string${maximum === undefined ? "" : ` no longer than ${maximum} characters`}`,
      field,
    );
  }
  return value;
};

const requirementItemPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

function parseRequirementList(value: string | undefined, field: string): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  let candidates: unknown;
  if (value.trimStart().startsWith("[")) {
    try {
      candidates = JSON.parse(value) as unknown;
    } catch {
      throw new SkillParseError(
        "SKILL_REQUIREMENT_INVALID",
        `Skill metadata '${field}' must be a JSON string array or a comma-separated list`,
        `metadata.${field}`,
      );
    }
  } else {
    candidates = value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(candidates)
    || candidates.length > 64
    || !candidates.every((item) => typeof item === "string" && requirementItemPattern.test(item))) {
    throw new SkillParseError(
      "SKILL_REQUIREMENT_INVALID",
      `Skill metadata '${field}' contains an invalid requirement identifier`,
      `metadata.${field}`,
    );
  }
  return [...new Set(candidates as string[])];
}

function parseMetadata(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze(Object.create(null) as Record<string, string>);
  const record = asRecord(value);
  if (!record) {
    throw new SkillParseError("SKILL_METADATA_INVALID", "Skill 'metadata' must be a string-to-string mapping", "metadata");
  }
  const metadata = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(record)) {
    if (key.length === 0 || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)
      || typeof entry !== "string" || entry.length > 4_096) {
      throw new SkillParseError(
        "SKILL_METADATA_INVALID",
        "Skill metadata keys and values must be bounded strings",
        `metadata.${key}`,
      );
    }
    metadata[key] = entry;
  }
  return Object.freeze(metadata);
}

export function parseSkillDocument(source: string, options: ParseSkillOptions = {}): ParsedSkillDocument {
  const sliced = splitSkillDocument(source);
  const document = parseDocument(sliced.yaml, {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new SkillParseError(
      "SKILL_FRONTMATTER_INVALID",
      `SKILL.md frontmatter is invalid: ${document.errors[0]?.message ?? "unknown YAML error"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    throw new SkillParseError(
      "SKILL_FRONTMATTER_INVALID",
      `SKILL.md frontmatter is unsafe: ${error instanceof Error ? error.message : "invalid YAML"}`,
    );
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new SkillParseError("SKILL_FRONTMATTER_INVALID", "SKILL.md frontmatter must be a mapping");
  }

  const name = requiredString(record, "name", 1, 64, "SKILL_NAME_INVALID");
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillParseError(
      "SKILL_NAME_INVALID",
      "Skill 'name' must contain lowercase letters, digits, and single hyphens only",
      "name",
    );
  }
  if (options.directoryName !== undefined && name !== options.directoryName) {
    throw new SkillParseError(
      "SKILL_NAME_MISMATCH",
      `Skill name '${name}' does not match its directory '${options.directoryName}'`,
      "name",
    );
  }
  const description = requiredString(record, "description", 1, 1_024, "SKILL_DESCRIPTION_INVALID");
  const license = optionalString(record, "license");
  const compatibility = optionalString(record, "compatibility", 500);
  const allowedTools = optionalString(record, "allowed-tools");
  const metadata = parseMetadata(record.metadata);
  const requirements: SkillRequirements = Object.freeze({
    tools: parseRequirementList(metadata["harnest-tools"], "harnest-tools"),
    connections: parseRequirementList(metadata["harnest-connections"], "harnest-connections"),
    permissions: parseRequirementList(metadata["harnest-permissions"], "harnest-permissions"),
  });

  const descriptor: SkillDescriptor = Object.freeze({
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    metadata,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    requirements,
  });
  return { descriptor, body: sliced.body };
}
