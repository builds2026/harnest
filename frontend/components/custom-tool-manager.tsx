"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { ConnectionSummary } from "@/lib/connections";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { useI18n } from "./i18n-provider";

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
  const { t } = useI18n();
  const [method, setMethod] = useState<ToolMethod>("http");
  const [id, setId] = useState("custom.tool");
  const [label, setLabel] = useState(() => t("tools.defaultLabel"));
  const [description, setDescription] = useState(() => t("tools.defaultDescription"));
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
      setMessage(t("tools.schemasGenerated"));
    } catch (error) {
      setMessage(apiErrorMessage(error, t("tools.schemasFailed"), t));
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
      const payload = await requestJson<{ output?: unknown }>("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, { timeoutMs: 120_000 });
      if (action === "test") {
        setTestOutput(JSON.stringify(payload.output, null, 2));
        setMessage(t("tools.testCompleted"));
      } else {
        await onChanged();
        setMessage(t("tools.savedMessage"));
      }
    } catch (error) {
      setMessage(apiErrorMessage(error, t("tools.actionFailed"), t));
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
      const payload = await requestJson<{ tools: unknown[]; warnings?: string[] }>("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import-openapi",
          document: openApiDocument,
          operationIds: operationIds.split(/[\s,]+/).filter(Boolean),
        }),
      }, { timeoutMs: 120_000 });
      await onChanged();
      setMessage(`${t("tools.imported", { count: payload.tools.length })}${payload.warnings?.length ? t("tools.importWarnings", { count: payload.warnings.length }) : ""}`);
    } catch (error) {
      setMessage(apiErrorMessage(error, t("tools.importFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="sheet-backdrop" />
      <Dialog.Viewport className="connection-sheet-viewport">
    <Dialog.Popup className="connection-sheet tool-sheet">
      <header className="sheet-header"><div><span className="sheet-eyebrow">{t("tools.registry")}</span><Dialog.Title id="tool-sheet-title">{t("tools.new")}</Dialog.Title></div><Dialog.Close className="sheet-close" aria-label={t("tools.close")} disabled={busy}>×</Dialog.Close></header>
      {message && <div className="sheet-message" role="status">{message}</div>}
      <form className="connection-form" onSubmit={method === "openapi" ? importOpenApi : (event) => { event.preventDefault(); void perform("save"); }}>
        <div className="field-grid">
          <div className="field"><label htmlFor="tool-method">{t("tools.method")}</label><select id="tool-method" value={method} onChange={(event) => setMethod(event.target.value as ToolMethod)}><option value="http">{t("tools.method.http")}</option><option value="openapi">{t("tools.method.openapi")}</option><option value="local-command">{t("tools.method.command")}</option><option value="typescript-module">{t("tools.method.module")}</option></select></div>
          {method !== "openapi" && <>
            <div className="field"><label htmlFor="tool-id">{t("tools.id")}</label><input ref={firstField} id="tool-id" required pattern="[a-z][a-z0-9._-]*" value={id} onChange={(event) => setId(event.target.value)} /></div>
            <div className="field"><label htmlFor="tool-label">{t("tools.label")}</label><input id="tool-label" required value={label} onChange={(event) => setLabel(event.target.value)} /></div>
            <div className="field"><label htmlFor="tool-description">{t("tools.description")}</label><textarea id="tool-description" required value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div className="field"><label htmlFor="tool-risk">{t("tools.risk")}</label><select id="tool-risk" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}><option value="read">{t("risk.read")}</option><option value="write">{t("risk.write")}</option><option value="external">{t("risk.external")}</option><option value="destructive">{t("risk.destructive")}</option></select></div>
          </>}
          <div className="field"><label htmlFor="tool-connection">{t("tools.testConnection")}</label><select id="tool-connection" required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">{t("tools.selectConnection")}</option>{compatibleConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {t(`connections.status.${connection.status}`)}</option>)}</select><span className="field-help">{t("tools.connectionHelp")}</span></div>
          {method === "http" && <><div className="field"><label htmlFor="tool-url">{t("tools.endpoint")}</label><input id="tool-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></div><div className="field"><label htmlFor="tool-http-method">{t("tools.httpMethod")}</label><select id="tool-http-method" value={httpMethod} onChange={(event) => setHttpMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => <option key={value}>{value}</option>)}</select></div></>}
          {method === "openapi" && <><div className="field"><label htmlFor="tool-openapi">{t("tools.openapiFile")}</label><input ref={firstField} id="tool-openapi" required placeholder="api/openapi.yaml" value={openApiDocument} onChange={(event) => setOpenApiDocument(event.target.value)} /></div><div className="field"><label htmlFor="tool-operations">{t("tools.operationIds")}</label><input id="tool-operations" placeholder={t("tools.operationIds.placeholder")} value={operationIds} onChange={(event) => setOperationIds(event.target.value)} /></div></>}
          {method === "local-command" && <><div className="field"><label htmlFor="tool-command">{t("tools.command")}</label><input id="tool-command" required value={command} onChange={(event) => setCommand(event.target.value)} /></div><div className="field"><label htmlFor="tool-args">{t("tools.arguments")}</label><input id="tool-args" value={args} onChange={(event) => setArgs(event.target.value)} /></div><div className="field"><label htmlFor="tool-cwd">{t("tools.cwd")}</label><input id="tool-cwd" required value={cwd} onChange={(event) => setCwd(event.target.value)} /></div><div className="field"><label htmlFor="tool-output">{t("tools.outputMode")}</label><select id="tool-output" value={outputMode} onChange={(event) => setOutputMode(event.target.value as typeof outputMode)}><option value="json">JSON</option><option value="text">{t("tools.outputMode.text")}</option><option value="record">{t("tools.outputMode.record")}</option></select></div></>}
          {method === "typescript-module" && <><div className="field"><label htmlFor="tool-module">{t("tools.module")}</label><input id="tool-module" required placeholder="./tools/example.ts" value={moduleName} onChange={(event) => setModuleName(event.target.value)} /></div><div className="field"><label htmlFor="tool-export">{t("tools.exportName")}</label><input id="tool-export" required value={exportName} onChange={(event) => setExportName(event.target.value)} /></div></>}
          {method !== "openapi" && <details className="advanced-panel" open><summary>{t("tools.schemas")}</summary><div className="field-grid"><div className="field"><label htmlFor="tool-input-example">{t("tools.exampleInput")}</label><textarea id="tool-input-example" spellCheck={false} value={inputExample} onChange={(event) => setInputExample(event.target.value)} /></div><div className="field"><label htmlFor="tool-output-example">{t("tools.exampleOutput")}</label><textarea id="tool-output-example" spellCheck={false} value={outputExample} onChange={(event) => setOutputExample(event.target.value)} /></div><button className="button" type="button" onClick={generate}>{t("tools.generateSchemas")}</button><div className="field"><label htmlFor="tool-input-schema">{t("tools.inputSchema")}</label><textarea id="tool-input-schema" spellCheck={false} value={inputSchema} onChange={(event) => setInputSchema(event.target.value)} /></div><div className="field"><label htmlFor="tool-output-schema">{t("tools.outputSchema")}</label><textarea id="tool-output-schema" spellCheck={false} value={outputSchema} onChange={(event) => setOutputSchema(event.target.value)} /></div></div></details>}
        </div>
        {testOutput && <pre className="tool-test-output">{testOutput}</pre>}
        <div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>{method !== "openapi" && <button type="button" className="button" disabled={busy} onClick={() => void perform("test")}>{t("tools.test")}</button>}<button className="button button-primary" disabled={busy}>{busy ? t("tools.working") : method === "openapi" ? t("tools.importOperations") : t("tools.save")}</button></div>
      </form>
    </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
