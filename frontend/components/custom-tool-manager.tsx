"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectionSummary } from "@/lib/connections";

type ToolMethod = "http" | "openapi" | "local-command" | "typescript-module";

const schemaFor = (value: unknown): Record<string, unknown> => {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", items: value.length ? schemaFor(value[0]) : {} };
  if (typeof value === "object") {
    const properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, schemaFor(item)]));
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: typeof value };
};

const requestMessage = async (response: Response) => {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? `Request failed with ${response.status}`;
};

export function CustomToolManager({
  open,
  connections,
  onClose,
  onChanged,
}: {
  open: boolean;
  connections: readonly ConnectionSummary[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [method, setMethod] = useState<ToolMethod>("http");
  const [id, setId] = useState("custom.tool");
  const [label, setLabel] = useState("Custom tool");
  const [description, setDescription] = useState("One project-scoped custom tool.");
  const [risk, setRisk] = useState<"read" | "write" | "external" | "destructive">("external");
  const [connectionId, setConnectionId] = useState("");
  const [url, setUrl] = useState("");
  const [httpMethod, setHttpMethod] = useState("POST");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState(".");
  const [outputMode, setOutputMode] = useState<"record" | "json" | "text">("json");
  const [moduleName, setModuleName] = useState("");
  const [exportName, setExportName] = useState("default");
  const [openApiDocument, setOpenApiDocument] = useState("");
  const [operationIds, setOperationIds] = useState("");
  const [inputExample, setInputExample] = useState("{}");
  const [outputExample, setOutputExample] = useState("{}");
  const [inputSchema, setInputSchema] = useState("{\n  \"type\": \"object\",\n  \"additionalProperties\": true\n}");
  const [outputSchema, setOutputSchema] = useState("");
  const [message, setMessage] = useState("");
  const [testOutput, setTestOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setTestOutput("");
    queueMicrotask(() => firstField.current?.focus());
  }, [open]);

  if (!open) return null;

  const requiredKinds = method === "http" || method === "openapi"
    ? ["http-api", "tool-service"]
    : ["local-runtime"];
  const compatibleConnections = connections.filter((connection) => requiredKinds.includes(connection.kind));

  const parsedJson = (text: string, labelText: string, optional = false) => {
    if (optional && !text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${labelText} must be valid JSON.`);
    }
  };

  const manifest = () => {
    const common = {
      manifestVersion: "1",
      id,
      label,
      description,
      category: "Custom",
      risk,
      connectionKinds: requiredKinds,
      inputSchema: parsedJson(inputSchema, "Input schema"),
      ...(outputSchema.trim() ? { outputSchema: parsedJson(outputSchema, "Output schema") } : {}),
    };
    if (method === "http") return {
      ...common,
      kind: "http",
      source: "custom",
      request: {
        method: httpMethod,
        url,
        ...(httpMethod === "GET" || httpMethod === "HEAD" ? {} : { body: { source: "input" } }),
        response: "auto",
      },
    };
    if (method === "local-command") return {
      ...common,
      kind: "local-command",
      source: "custom",
      command,
      args: args.split(/\s+/).filter(Boolean),
      cwd,
      stdin: "json",
      output: outputMode,
    };
    return { ...common, kind: "typescript-module", source: "module", module: moduleName, exportName };
  };

  const generate = () => {
    try {
      setInputSchema(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schemaFor(parsedJson(inputExample, "Input example")) }, null, 2));
      if (outputExample.trim()) setOutputSchema(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schemaFor(parsedJson(outputExample, "Output example")) }, null, 2));
      setMessage("Editable schemas generated from the examples.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schemas could not be generated.");
    }
  };

  const perform = async (action: "test" | "save") => {
    setBusy(true);
    setMessage("");
    try {
      if (!connectionId) throw new Error("Select a compatible Connection before testing or saving this Tool.");
      const body = action === "test"
        ? { action, manifest: manifest(), input: parsedJson(inputExample, "Input example"), connectionId }
        : { action, manifest: manifest() };
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await requestMessage(response));
      const payload = await response.json() as { output?: unknown };
      if (action === "test") {
        setTestOutput(JSON.stringify(payload.output, null, 2));
        setMessage("Test completed through the current host capability policy.");
      } else {
        await onChanged();
        setMessage("Tool saved to this project and added to the runtime catalog.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tool action failed.");
    } finally {
      setBusy(false);
    }
  };

  const importOpenApi = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (!connectionId) throw new Error("Select a compatible Connection for imported HTTP operations.");
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import-openapi",
          document: openApiDocument,
          operationIds: operationIds.split(/[\s,]+/).filter(Boolean),
        }),
      });
      if (!response.ok) throw new Error(await requestMessage(response));
      const payload = await response.json() as { tools: unknown[]; warnings?: string[] };
      await onChanged();
      setMessage(`${payload.tools.length} OpenAPI operation(s) imported.${payload.warnings?.length ? ` ${payload.warnings.length} warning(s).` : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "OpenAPI import failed.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop">
    <section className="connection-sheet tool-sheet" role="dialog" aria-modal="true" aria-labelledby="tool-sheet-title">
      <header className="sheet-header"><div><span className="sheet-eyebrow">Project Tool Registry</span><h2 id="tool-sheet-title">New custom tool</h2></div><button className="sheet-close" aria-label="Close custom tool" disabled={busy} onClick={onClose}>×</button></header>
      {message && <div className="sheet-message" role="status">{message}</div>}
      <form className="connection-form" onSubmit={method === "openapi" ? importOpenApi : (event) => { event.preventDefault(); void perform("save"); }}>
        <div className="field-grid">
          <div className="field"><label htmlFor="tool-method">Method</label><select id="tool-method" value={method} onChange={(event) => setMethod(event.target.value as ToolMethod)}><option value="http">HTTP Endpoint</option><option value="openapi">OpenAPI document</option><option value="local-command">Local Command</option><option value="typescript-module">TypeScript Module</option></select></div>
          {method !== "openapi" && <>
            <div className="field"><label htmlFor="tool-id">Tool id</label><input ref={firstField} id="tool-id" required pattern="[a-z][a-z0-9._-]*" value={id} onChange={(event) => setId(event.target.value)} /></div>
            <div className="field"><label htmlFor="tool-label">Label</label><input id="tool-label" required value={label} onChange={(event) => setLabel(event.target.value)} /></div>
            <div className="field"><label htmlFor="tool-description">Description</label><textarea id="tool-description" required value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div className="field"><label htmlFor="tool-risk">Risk</label><select id="tool-risk" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}><option value="read">Read</option><option value="write">Write</option><option value="external">External transfer</option><option value="destructive">Destructive</option></select></div>
          </>}
          <div className="field"><label htmlFor="tool-connection">Test connection</label><select id="tool-connection" required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">Select a connection</option>{compatibleConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.status.replaceAll("_", " ")}</option>)}</select><span className="field-help">The saved manifest stores compatible kinds only. The selected Connection ID is attached in the harness.</span></div>
          {method === "http" && <><div className="field"><label htmlFor="tool-url">Endpoint URL</label><input id="tool-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></div><div className="field"><label htmlFor="tool-http-method">HTTP method</label><select id="tool-http-method" value={httpMethod} onChange={(event) => setHttpMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => <option key={value}>{value}</option>)}</select></div></>}
          {method === "openapi" && <><div className="field"><label htmlFor="tool-openapi">Project-relative OpenAPI file</label><input ref={firstField} id="tool-openapi" required placeholder="api/openapi.yaml" value={openApiDocument} onChange={(event) => setOpenApiDocument(event.target.value)} /></div><div className="field"><label htmlFor="tool-operations">Operation IDs</label><input id="tool-operations" placeholder="Leave blank to import supported operations" value={operationIds} onChange={(event) => setOperationIds(event.target.value)} /></div></>}
          {method === "local-command" && <><div className="field"><label htmlFor="tool-command">Approved command</label><input id="tool-command" required value={command} onChange={(event) => setCommand(event.target.value)} /></div><div className="field"><label htmlFor="tool-args">Arguments</label><input id="tool-args" value={args} onChange={(event) => setArgs(event.target.value)} /></div><div className="field"><label htmlFor="tool-cwd">Project-relative working directory</label><input id="tool-cwd" required value={cwd} onChange={(event) => setCwd(event.target.value)} /></div><div className="field"><label htmlFor="tool-output">Output mode</label><select id="tool-output" value={outputMode} onChange={(event) => setOutputMode(event.target.value as typeof outputMode)}><option value="json">JSON</option><option value="text">Text</option><option value="record">Process record</option></select></div></>}
          {method === "typescript-module" && <><div className="field"><label htmlFor="tool-module">Project-relative module or package</label><input id="tool-module" required placeholder="./tools/example.ts" value={moduleName} onChange={(event) => setModuleName(event.target.value)} /></div><div className="field"><label htmlFor="tool-export">Export name</label><input id="tool-export" required value={exportName} onChange={(event) => setExportName(event.target.value)} /></div></>}
          {method !== "openapi" && <details className="advanced-panel" open><summary>Schemas & test example</summary><div className="field-grid"><div className="field"><label htmlFor="tool-input-example">Example input</label><textarea id="tool-input-example" spellCheck={false} value={inputExample} onChange={(event) => setInputExample(event.target.value)} /></div><div className="field"><label htmlFor="tool-output-example">Example output</label><textarea id="tool-output-example" spellCheck={false} value={outputExample} onChange={(event) => setOutputExample(event.target.value)} /></div><button className="button" type="button" onClick={generate}>Generate editable schemas</button><div className="field"><label htmlFor="tool-input-schema">Input JSON Schema</label><textarea id="tool-input-schema" spellCheck={false} value={inputSchema} onChange={(event) => setInputSchema(event.target.value)} /></div><div className="field"><label htmlFor="tool-output-schema">Output JSON Schema</label><textarea id="tool-output-schema" spellCheck={false} value={outputSchema} onChange={(event) => setOutputSchema(event.target.value)} /></div></div></details>}
        </div>
        {testOutput && <pre className="tool-test-output">{testOutput}</pre>}
        <div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>{method !== "openapi" && <button type="button" className="button" disabled={busy} onClick={() => void perform("test")}>Test</button>}<button className="button button-primary" disabled={busy}>{busy ? "Working…" : method === "openapi" ? "Import operations" : "Save tool"}</button></div>
      </form>
    </section>
  </div>;
}
