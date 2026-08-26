const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function interactionOptions(
  schema?: Readonly<Record<string, unknown>>,
  data?: Readonly<Record<string, unknown>>,
): readonly { readonly value: string | number | boolean; readonly label: string }[] {
  const listed = Array.isArray(data?.options) ? data.options.flatMap((candidate) => {
    const item = record(candidate);
    return item && ["string", "number", "boolean"].includes(typeof item.value)
      ? [{ value: item.value as string | number | boolean, label: typeof item.label === "string" ? item.label : String(item.value) }]
      : [];
  }) : [];
  if (listed.length) return listed;
  return Array.isArray(schema?.enum) ? schema.enum.flatMap((value) =>
    ["string", "number", "boolean"].includes(typeof value)
      ? [{ value: value as string | number | boolean, label: String(value) }]
      : []) : [];
}

export const interactionInputValue = (type: unknown, value: string, valueAsNumber: number): unknown =>
  type === "number" || type === "integer" ? (value === "" ? "" : valueAsNumber) : value;
