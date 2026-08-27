"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { StoredToolManifest } from "@harnestai/core/node";
import type { ConnectionSummary } from "@/lib/connections";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { useI18n } from "./i18n-provider";
import { ArgumentList } from "./argument-list";
import { Button, ConfirmDialog, EmptyState, InlineNotice, Skeleton } from "./ui/ui";

type ToolMethod = "http" | "openapi" | "openapi-operation" | "local-command" | "typescript-module";

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
  const [args, setArgs] = useState<string[]>([]);
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
  const [tools, setTools] = useState<readonly StoredToolManifest[]>([]);
  const [view, setView] = useState<"list" | "form">("list");
  const [editing, setEditing] = useState<StoredToolManifest>();
  const [deleteTool, setDeleteTool] = useState<StoredToolManifest>();
  const [feedback, setFeedback] = useState<{ tone: "success" | "warning" | "danger"; text: string }>();
  const [testOutput, setTestOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFeedback(undefined);
    setTestOutput("");
    setView("list");
    setBusy(true);
    void requestJson<{ tools: StoredToolManifest[]; warnings?: string[] }>("/api/tools", { cache: "no-store" }).then((payload) => {
      setTools(payload.tools);
      if (payload.warnings?.length) setFeedback({ tone: "warning", text: t("tools.loadWarnings", { count: payload.warnings.length }) });
    }).catch((error: unknown) => setFeedback({ tone: "danger", text: apiErrorMessage(error, t("tools.loadFailed"), t) }))
      .finally(() => setBusy(false));
  }, [open, t]);

  if (!open) return null;

  const requiredKinds = method === "http" || method === "openapi" || method === "openapi-operation"
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

  const refreshTools = async () => {
    const payload = await requestJson<{ tools: StoredToolManifest[] }>("/api/tools", { cache: "no-store" });
    setTools(payload.tools);
  };

  const newTool = (nextMethod: ToolMethod = "http") => {
    setEditing(undefined);
    setMethod(nextMethod);
    setId("custom.tool");
    setLabel(t("tools.defaultLabel"));
    setDescription(t("tools.defaultDescription"));
    setRisk("external");
    setConnectionId("");
    setUrl("");
    setHttpMethod("POST");
    setCommand("");
    setArgs([]);
    setCwd(".");
    setOutputMode("json");
    setModuleName("");
    setExportName("default");
    setOpenApiDocument("");
    setOperationIds("");
    setInputSchema("{\n  \"type\": \"object\",\n  \"additionalProperties\": true\n}");
    setOutputSchema("");
    setTestOutput("");
    setFeedback(undefined);
    setView("form");
    queueMicrotask(() => firstField.current?.focus());
  };

  const editTool = (tool: StoredToolManifest) => {
    setEditing(tool);
    setMethod(tool.kind);
    setId(tool.id);
    setLabel(tool.label);
    setDescription(tool.description);
    setRisk(tool.risk ?? "external");
    setConnectionId("");
    setInputSchema(JSON.stringify(tool.inputSchema, null, 2));
    setOutputSchema(tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : "");
    setInputExample("{}");
    setOutputExample("{}");
    if (tool.kind === "http" || tool.kind === "openapi-operation") {
      setUrl(tool.request.url);
      setHttpMethod(tool.request.method);
    } else if (tool.kind === "local-command") {
      setCommand(tool.command);
      setArgs([...(tool.args ?? [])]);
      setCwd(tool.cwd ?? ".");
      setOutputMode(tool.output ?? "json");
    } else {
      setModuleName(tool.module);
      setExportName(tool.exportName ?? "default");
    }
    setTestOutput("");
    setFeedback(undefined);
    setView("form");
    queueMicrotask(() => firstField.current?.focus());
  };

  const manifest = () => {
    const common = {
      manifestVersion: "1",
      id,
      label,
      description,
      category: editing?.category ?? "Custom",
      risk,
      ...(editing ? editing.connectionKinds ? { connectionKinds: editing.connectionKinds } : {} : { connectionKinds: requiredKinds }),
      inputSchema: parsedJson(inputSchema, "Input schema"),
      ...(outputSchema.trim() ? { outputSchema: parsedJson(outputSchema, "Output schema") } : {}),
    };
    if (method === "http" || method === "openapi-operation") {
      const previous = method === "http" && editing?.kind === "http" ? editing.request
        : method === "openapi-operation" && editing?.kind === "openapi-operation" ? editing.request : undefined;
      const { body: previousBody, ...previousRequest } = previous ?? {};
      const request = {
        ...previousRequest,
        method: httpMethod,
        url,
        ...(httpMethod === "GET" || httpMethod === "HEAD" ? {} : { body: previousBody ?? { source: "input" } }),
        response: previous?.response ?? "auto",
      };
      if (method === "openapi-operation" && editing?.kind === "openapi-operation") return {
        ...common,
        kind: "openapi-operation",
        source: "custom",
        document: editing.document,
        operationId: editing.operationId,
        request,
      };
      return {
        ...common,
        kind: "http",
        source: "custom",
        request,
      };
    }
    if (method === "local-command") return {
      ...common,
      kind: "local-command",
      source: "custom",
      command,
      args,
      cwd,
      stdin: editing?.kind === "local-command" ? editing.stdin ?? "json" : "json",
      output: outputMode,
      ...(editing?.kind === "local-command" && editing.timeoutMs !== undefined ? { timeoutMs: editing.timeoutMs } : {}),
    };
    return {
      ...common,
      kind: "typescript-module",
      source: "module",
      module: moduleName,
      exportName,
      ...(editing?.kind === "typescript-module" && editing.timeoutMs !== undefined ? { timeoutMs: editing.timeoutMs } : {}),
    };
  };

  const generate = () => {
    try {
      setInputSchema(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schemaFor(parsedJson(inputExample, "Input example")) }, null, 2));
      if (outputExample.trim()) setOutputSchema(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schemaFor(parsedJson(outputExample, "Output example")) }, null, 2));
      setFeedback({ tone: "success", text: t("tools.schemasGenerated") });
    } catch (error) {
      setFeedback({ tone: "danger", text: apiErrorMessage(error, t("tools.schemasFailed"), t) });
    }
  };

  const perform = async (action: "test" | "save") => {
    setBusy(true);
    setFeedback(undefined);
    try {
      const body = action === "test"
        ? { action, manifest: manifest(), input: parsedJson(inputExample, "Input example"), ...(connectionId ? { connectionId } : {}) }
        : { action, manifest: manifest() };
      const payload = await requestJson<{ output?: unknown }>("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, { timeoutMs: 120_000 });
      if (action === "test") {
        setTestOutput(JSON.stringify(payload.output, null, 2));
        setFeedback({ tone: "success", text: t("tools.testCompleted") });
      } else {
        await refreshTools();
        await onChanged();
        setView("list");
        setFeedback({ tone: "success", text: t(editing ? "tools.updatedMessage" : "tools.savedMessage") });
      }
    } catch (error) {
      setFeedback({ tone: "danger", text: apiErrorMessage(error, t("tools.actionFailed"), t) });
    } finally {
      setBusy(false);
    }
  };

  const importOpenApi = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback(undefined);
    try {
      const payload = await requestJson<{ tools: unknown[]; warnings?: string[] }>("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import-openapi",
          document: openApiDocument,
          operationIds: operationIds.split(/[\s,]+/).filter(Boolean),
        }),
      }, { timeoutMs: 120_000 });
      await refreshTools();
      await onChanged();
      setView("list");
      setFeedback({ tone: payload.warnings?.length ? "warning" : "success", text: `${t("tools.imported", { count: payload.tools.length })}${payload.warnings?.length ? t("tools.importWarnings", { count: payload.warnings.length }) : ""}` });
    } catch (error) {
      setFeedback({ tone: "danger", text: apiErrorMessage(error, t("tools.importFailed"), t) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTool) return;
    const target = deleteTool;
    setBusy(true);
    setFeedback(undefined);
    try {
      await requestJson("/api/tools", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      setDeleteTool(undefined);
      await refreshTools();
      await onChanged();
      setFeedback({ tone: "success", text: t("tools.deletedMessage", { id: target.id }) });
    } catch (error) {
      setFeedback({ tone: "danger", text: apiErrorMessage(error, t("tools.deleteFailed"), t) });
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="sheet-backdrop" />
        <Dialog.Viewport className="connection-sheet-viewport">
          <Dialog.Popup className="connection-sheet tool-sheet">
            <header className="sheet-header"><div><span className="sheet-eyebrow">{t("tools.registry")}</span><Dialog.Title id="tool-sheet-title">{view === "list" ? t("tools.manage") : editing ? t("tools.edit") : t("tools.new")}</Dialog.Title></div><Dialog.Close className="sheet-close" aria-label={t("tools.close")} disabled={busy}>×</Dialog.Close></header>
            {feedback && <InlineNotice tone={feedback.tone}>{feedback.text}</InlineNotice>}
            {view === "list" ? <>
              <div className="tool-registry-toolbar"><p>{t("tools.installedCount", { count: tools.length })}</p><span><Button disabled={busy} onClick={() => newTool("openapi")}>{t("tools.importOperations")}</Button> <Button variant="primary" disabled={busy} onClick={() => newTool()}>{t("tools.new")}</Button></span></div>
              <div className="tool-registry-list">
                {busy && !tools.length ? <Skeleton lines={5} label={t("common.loading")} /> : tools.length ? tools.map((tool) => <article className="tool-registry-card" key={tool.id}><div><strong>{tool.label}</strong><span>{tool.description}</span><code>{tool.id} · {t(`tools.kind.${tool.kind}`)}</code></div><div className="tool-registry-card-actions"><Button size="small" disabled={busy} onClick={() => editTool(tool)}>{t("common.edit")}</Button><Button size="small" variant="danger" disabled={busy} onClick={() => setDeleteTool(tool)}>{t("common.delete")}</Button></div></article>) : <EmptyState title={t("tools.empty.title")} description={t("tools.empty.description")} action={<Button variant="primary" onClick={() => newTool()}>{t("tools.new")}</Button>} />}
              </div>
            </> : <form className="connection-form" onSubmit={method === "openapi" ? importOpenApi : (event) => { event.preventDefault(); void perform("save"); }}>
              <div className="field-grid">
                <div className="field"><label htmlFor="tool-method">{t("tools.method")}</label><select id="tool-method" disabled={Boolean(editing)} value={method} onChange={(event) => setMethod(event.target.value as ToolMethod)}><option value="http">{t("tools.method.http")}</option><option value="openapi">{t("tools.method.openapi")}</option>{method === "openapi-operation" && <option value="openapi-operation">{t("tools.method.openapiOperation")}</option>}<option value="local-command">{t("tools.method.command")}</option><option value="typescript-module">{t("tools.method.module")}</option></select></div>
                {method !== "openapi" && <>
                  <div className="field"><label htmlFor="tool-id">{t("tools.id")}</label><input ref={firstField} id="tool-id" required disabled={Boolean(editing)} pattern="[a-z][a-z0-9._-]*" value={id} onChange={(event) => setId(event.target.value)} /></div>
                  <div className="field"><label htmlFor="tool-label">{t("tools.label")}</label><input id="tool-label" required value={label} onChange={(event) => setLabel(event.target.value)} /></div>
                  <div className="field"><label htmlFor="tool-description">{t("tools.description")}</label><textarea id="tool-description" required value={description} onChange={(event) => setDescription(event.target.value)} /></div>
                  <div className="field"><label htmlFor="tool-risk">{t("tools.risk")}</label><select id="tool-risk" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}><option value="read">{t("risk.read")}</option><option value="write">{t("risk.write")}</option><option value="external">{t("risk.external")}</option><option value="destructive">{t("risk.destructive")}</option></select></div>
                  <div className="field"><label htmlFor="tool-connection">{t("tools.testConnection")} <span className="field-optional">{t("connections.form.optional")}</span></label><select id="tool-connection" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">{t("tools.noConnection")}</option>{compatibleConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {t(`connections.status.${connection.status}`)}</option>)}</select><span className="field-help">{t("tools.connectionHelp")}</span></div>
                </>}
                {(method === "http" || method === "openapi-operation") && <><div className="field"><label htmlFor="tool-url">{t("tools.endpoint")}</label><input id="tool-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></div><div className="field"><label htmlFor="tool-http-method">{t("tools.httpMethod")}</label><select id="tool-http-method" value={httpMethod} onChange={(event) => setHttpMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => <option key={value}>{value}</option>)}</select></div></>}
                {method === "openapi" && <><div className="field"><label htmlFor="tool-openapi">{t("tools.openapiFile")}</label><input ref={firstField} id="tool-openapi" required placeholder="api/openapi.yaml" value={openApiDocument} onChange={(event) => setOpenApiDocument(event.target.value)} /></div><div className="field"><label htmlFor="tool-operations">{t("tools.operationIds")}</label><input id="tool-operations" placeholder={t("tools.operationIds.placeholder")} value={operationIds} onChange={(event) => setOperationIds(event.target.value)} /></div><p className="field-help">{t("tools.importConnectionHelp")}</p></>}
                {method === "local-command" && <><div className="field"><label htmlFor="tool-command">{t("tools.command")}</label><input id="tool-command" required value={command} onChange={(event) => setCommand(event.target.value)} /></div><ArgumentList id="tool-args" label={t("tools.arguments")} args={args} addLabel={t("common.addArgument")} removeLabel={t("common.removeArgument")} disabled={busy} onChange={setArgs} /><div className="field"><label htmlFor="tool-cwd">{t("tools.cwd")}</label><input id="tool-cwd" required value={cwd} onChange={(event) => setCwd(event.target.value)} /></div><div className="field"><label htmlFor="tool-output">{t("tools.outputMode")}</label><select id="tool-output" value={outputMode} onChange={(event) => setOutputMode(event.target.value as typeof outputMode)}><option value="json">JSON</option><option value="text">{t("tools.outputMode.text")}</option><option value="record">{t("tools.outputMode.record")}</option></select></div></>}
                {method === "typescript-module" && <><div className="field"><label htmlFor="tool-module">{t("tools.module")}</label><input id="tool-module" required placeholder="./tools/example.ts" value={moduleName} onChange={(event) => setModuleName(event.target.value)} /></div><div className="field"><label htmlFor="tool-export">{t("tools.exportName")}</label><input id="tool-export" required value={exportName} onChange={(event) => setExportName(event.target.value)} /></div></>}
                {method !== "openapi" && <details className="advanced-panel" open><summary>{t("tools.schemas")}</summary><div className="field-grid"><div className="field"><label htmlFor="tool-input-example">{t("tools.exampleInput")}</label><textarea id="tool-input-example" spellCheck={false} value={inputExample} onChange={(event) => setInputExample(event.target.value)} /></div><div className="field"><label htmlFor="tool-output-example">{t("tools.exampleOutput")}</label><textarea id="tool-output-example" spellCheck={false} value={outputExample} onChange={(event) => setOutputExample(event.target.value)} /></div><Button type="button" onClick={generate}>{t("tools.generateSchemas")}</Button><div className="field"><label htmlFor="tool-input-schema">{t("tools.inputSchema")}</label><textarea id="tool-input-schema" spellCheck={false} value={inputSchema} onChange={(event) => setInputSchema(event.target.value)} /></div><div className="field"><label htmlFor="tool-output-schema">{t("tools.outputSchema")}</label><textarea id="tool-output-schema" spellCheck={false} value={outputSchema} onChange={(event) => setOutputSchema(event.target.value)} /></div></div></details>}
              </div>
              {testOutput && <pre className="tool-test-output">{testOutput}</pre>}
              <div className="sheet-actions"><Button type="button" disabled={busy} onClick={() => { setView("list"); setFeedback(undefined); }}>{t("common.back")}</Button>{method !== "openapi" && <Button type="button" disabled={busy} onClick={() => void perform("test")}>{t("tools.test")}</Button>}<Button variant="primary" loading={busy}>{method === "openapi" ? t("tools.importOperations") : t("tools.save")}</Button></div>
            </form>}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog open={Boolean(deleteTool)} title={t("tools.deleteTitle")} description={t("tools.deleteDescription", { id: deleteTool?.id ?? "" })} confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} danger onOpenChange={(next) => { if (!next && !busy) setDeleteTool(undefined); }} onConfirm={() => void remove()} />
  </>;
}
