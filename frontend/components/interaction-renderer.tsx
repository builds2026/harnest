"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useEffect, useMemo, useState } from "react";
import { interactionInputValue, interactionOptions } from "../lib/interaction-values";
import { useI18n } from "./i18n-provider";
import { Button, Checkbox, Field, Input, Select, Textarea } from "./ui/ui";
import styles from "./interaction-renderer.module.css";

export type InteractionKind = "select" | "input" | "form" | "file" | "oauth" | "permission";
export type InteractionAction = "submit" | "decline" | "cancel";
export type PermissionDecision = "allow_once" | "allow_for_run" | "allow_always" | "deny";

export interface InteractionView {
  readonly id: string;
  readonly runId: string;
  readonly kind: InteractionKind;
  readonly title: string;
  readonly message: string;
  readonly checkpoint: { readonly digest: string };
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly expiresAt?: string;
}

export interface InteractionFileView {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256?: string;
}

export interface InteractionResponseView {
  readonly interactionId: string;
  readonly checkpointDigest: string;
  readonly action: InteractionAction;
  readonly value?: unknown;
  readonly permission?: PermissionDecision;
}

interface SchemaProperty extends Readonly<Record<string, unknown>> {
  readonly type?: "string" | "number" | "integer" | "boolean";
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function validateValue(schema: SchemaProperty, value: unknown, required: boolean, t: ReturnType<typeof useI18n>["t"]): string | undefined {
  if (value === undefined || value === "") return required ? t("interaction.validation.required") : undefined;
  if (schema.type === "boolean") return typeof value === "boolean" ? undefined : t("interaction.validation.invalid");
  if (schema.type === "number" || schema.type === "integer") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || (schema.type === "integer" && !Number.isInteger(number))) return t("interaction.validation.number");
    if (typeof schema.minimum === "number" && number < schema.minimum) return t("interaction.validation.minimum", { value: schema.minimum });
    if (typeof schema.maximum === "number" && number > schema.maximum) return t("interaction.validation.maximum", { value: schema.maximum });
    return undefined;
  }
  const text = String(value);
  if (typeof schema.minLength === "number" && text.length < schema.minLength) return t("interaction.validation.minLength", { value: schema.minLength });
  if (typeof schema.maxLength === "number" && text.length > schema.maxLength) return t("interaction.validation.maxLength", { value: schema.maxLength });
  return undefined;
}

export function InteractionRenderer({
  request,
  files = [],
  busy = false,
  error,
  onRespond,
}: {
  request: InteractionView;
  files?: readonly InteractionFileView[];
  busy?: boolean;
  error?: string;
  onRespond: (response: InteractionResponseView) => void | Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [selectedFile, setSelectedFile] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const choiceOptions = useMemo(() => interactionOptions(request.schema, request.data), [request]);
  const objectSchema = record(request.schema);
  const properties = record(objectSchema?.properties) ?? {};
  const required = new Set(Array.isArray(objectSchema?.required) ? objectSchema.required.filter((key): key is string => typeof key === "string") : []);
  const fields = Object.entries(properties).flatMap(([key, value]) => {
    const schema = record(value) as SchemaProperty | undefined;
    return schema && ["string", "number", "integer", "boolean"].includes(schema.type ?? "") ? [{ key, schema }] : [];
  });

  useEffect(() => {
    setValues({});
    setSelectedFile("");
    setSubmitted(false);
  }, [request.id]);

  useEffect(() => {
    if (request.kind !== "oauth") return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const value = record(event.data);
      if (value?.type !== "harnest.oauth.complete" || value.interactionId !== request.id
        || typeof value.connectionRef !== "string") return;
      setValues({ connectionRef: value.connectionRef });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [request.id, request.kind]);

  const respond = (action: InteractionAction, value?: unknown, permission?: PermissionDecision) => onRespond({
    interactionId: request.id,
    checkpointDigest: request.checkpoint.digest,
    action,
    ...(value === undefined ? {} : { value }),
    ...(permission ? { permission } : {}),
  });

  const errors = Object.fromEntries(fields.flatMap(({ key, schema }) => {
    const message = validateValue(schema, values[key], required.has(key), t);
    return message ? [[key, message]] : [];
  }));
  if (request.kind === "input") {
    const message = validateValue((request.schema ?? {}) as SchemaProperty, values.value, request.schema?.required !== false, t);
    if (message) errors.value = message;
  }
  if (request.kind === "select" && (values.value === undefined || values.value === "")) {
    errors.value = t("interaction.validation.required");
  }
  if (request.kind === "file" && !selectedFile) errors.files = t("interaction.validation.required");
  if (request.kind === "oauth" && typeof values.connectionRef !== "string") errors.connectionRef = t("interaction.oauth.waiting");
  const invalid = submitted && Object.keys(errors).length > 0;

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    if (request.kind === "file") {
      const file = files.find(({ id }) => id === selectedFile);
      if (!file?.sha256) return;
      void respond("submit", {
        fileRef: file.id,
        mimeType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
      });
      return;
    }
    if (request.kind === "select") void respond("submit", values.value);
    else if (request.kind === "input") void respond("submit", values.value ?? "");
    else if (request.kind === "oauth") void respond("submit", { connectionRef: values.connectionRef });
    else void respond("submit", values);
  };

  const persistentPermissionDisabled = request.data?.previewLimited !== false || request.data?.resourceResolved !== true;

  if (request.kind === "permission") return <AlertDialog.Root open>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className={styles.backdrop} />
      <AlertDialog.Viewport className={styles.viewport}>
        <AlertDialog.Popup className={styles.dialog}>
          <AlertDialog.Title className={styles.title}>{request.title}</AlertDialog.Title>
          <AlertDialog.Description className={styles.message}>{request.message}</AlertDialog.Description>
          {request.data && <pre className={styles.preview}>{JSON.stringify(request.data, null, 2)}</pre>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.permissionActions}>
            <Button disabled={busy} variant="danger" onClick={() => void respond("decline", undefined, "deny")}>{t("interaction.permission.deny")}</Button>
            <Button disabled={busy || persistentPermissionDisabled} onClick={() => void respond("submit", undefined, "allow_always")}>{t("interaction.permission.always")}</Button>
            <Button disabled={busy} onClick={() => void respond("submit", undefined, "allow_for_run")}>{t("interaction.permission.run")}</Button>
            <Button disabled={busy} variant="primary" onClick={() => void respond("submit", undefined, "allow_once")}>{t("interaction.permission.once")}</Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Viewport>
    </AlertDialog.Portal>
  </AlertDialog.Root>;

  return <section className={styles.card} aria-labelledby={`interaction-${request.id}`}>
    <header><div><span>{t(`interaction.kind.${request.kind}`)}</span><h3 id={`interaction-${request.id}`}>{request.title}</h3></div>{request.expiresAt && <time dateTime={request.expiresAt}>{t("interaction.expires", { time: formatDate(request.expiresAt, { dateStyle: "medium", timeStyle: "short" }) })}</time>}</header>
    <p className={styles.message}>{request.message}</p>

    {request.kind === "select" && <Field label={typeof request.schema?.title === "string" ? request.schema.title : t("interaction.select.label")} htmlFor={`interaction-${request.id}-value`} error={submitted ? errors.value : undefined}>
      <Select id={`interaction-${request.id}-value`} value={values.value === undefined ? "" : String(choiceOptions.findIndex(({ value }) => Object.is(value, values.value)))} onChange={(event) => setValues({ value: choiceOptions[Number(event.target.value)]?.value })}>
        <option value="">{t("interaction.select.placeholder")}</option>
        {choiceOptions.map(({ value, label }, index) => <option key={`${typeof value}:${String(value)}`} value={index}>{label}</option>)}
      </Select>
    </Field>}

    {request.kind === "input" && request.schema?.type === "boolean" && !choiceOptions.length
      ? <Checkbox label={typeof request.schema.title === "string" ? request.schema.title : t("interaction.input.label")} checked={values.value === true} onCheckedChange={(checked) => setValues({ value: checked })} />
      : request.kind === "input" && <Field label={typeof request.schema?.title === "string" ? request.schema.title : t("interaction.input.label")} htmlFor={`interaction-${request.id}-value`} error={submitted ? errors.value : undefined}>
        {choiceOptions.length
          ? <Select id={`interaction-${request.id}-value`} value={values.value === undefined ? "" : String(choiceOptions.findIndex(({ value }) => Object.is(value, values.value)))} onChange={(event) => setValues({ value: choiceOptions[Number(event.target.value)]?.value })}><option value="">{t("interaction.select.placeholder")}</option>{choiceOptions.map(({ value, label }, index) => <option key={`${typeof value}:${String(value)}`} value={index}>{label}</option>)}</Select>
          : request.data?.multiline === true
            ? <Textarea id={`interaction-${request.id}-value`} value={String(values.value ?? "")} onChange={(event) => setValues({ value: event.target.value })} />
            : <Input id={`interaction-${request.id}-value`} type={request.schema?.type === "number" || request.schema?.type === "integer" ? "number" : request.schema?.format === "email" ? "email" : "text"} value={String(values.value ?? "")} onChange={(event) => setValues({ value: interactionInputValue(request.schema?.type, event.target.value, event.target.valueAsNumber) })} />}
      </Field>}

    {request.kind === "form" && <div className={styles.form}>{fields.map(({ key, schema }) => schema.type === "boolean"
      ? <Checkbox key={key} label={schema.title ?? key} checked={values[key] === true} onCheckedChange={(checked) => setValues((current) => ({ ...current, [key]: checked }))} />
      : <Field key={key} label={schema.title ?? key} htmlFor={`interaction-${request.id}-${key}`} hint={schema.description} error={submitted ? errors[key] : undefined}>
        {schema.enum?.length
          ? <Select id={`interaction-${request.id}-${key}`} value={values[key] === undefined ? "" : String(schema.enum.findIndex((value) => Object.is(value, values[key])))} onChange={(event) => setValues((current) => ({ ...current, [key]: schema.enum?.[Number(event.target.value)] }))}><option value="">{t("interaction.select.placeholder")}</option>{schema.enum.map((value, index) => <option key={`${typeof value}:${String(value)}`} value={index}>{String(value)}</option>)}</Select>
          : <Input id={`interaction-${request.id}-${key}`} type={schema.type === "number" || schema.type === "integer" ? "number" : schema.format === "email" ? "email" : "text"} value={String(values[key] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [key]: schema.type === "number" || schema.type === "integer" ? event.target.valueAsNumber : event.target.value }))} />}
      </Field>)}</div>}

    {request.kind === "file" && <div className={styles.fileList}>{files.some((file) => file.sha256)
      ? <Field label={t("interaction.kind.file")} htmlFor={`interaction-${request.id}-file`} error={submitted ? errors.files : undefined}>
        <Select id={`interaction-${request.id}-file`} value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)}>
          <option value="">{t("interaction.select.placeholder")}</option>
          {files.filter((file) => file.sha256).map((file) => <option key={file.id} value={file.id}>{file.name} · {file.mimeType}</option>)}
        </Select>
      </Field>
      : <p>{t("interaction.file.empty")}</p>}</div>}

    {request.kind === "oauth" && <div className={styles.oauth}><strong>{String(request.data?.provider ?? t("interaction.oauth.provider"))}</strong>{typeof request.data?.url === "string" && <a className={styles.oauthLink} href={request.data.url} target="_blank" rel="noreferrer">{t("interaction.oauth.open")}</a>}<small>{typeof values.connectionRef === "string" ? t("interaction.oauth.ready") : t("interaction.oauth.help")}</small></div>}
    {invalid && <p className={styles.error} role="alert">{t("interaction.validation.review")}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer><Button disabled={busy} onClick={() => void respond("cancel")}>{t("common.cancel")}</Button><Button disabled={busy} onClick={() => void respond("decline")}>{t("interaction.decline")}</Button><Button loading={busy} variant="primary" onClick={submit}>{request.kind === "oauth" ? t("interaction.oauth.complete") : t("interaction.submit")}</Button></footer>
  </section>;
}
