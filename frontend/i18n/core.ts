import { enUS, type MessageKey } from "./messages/en-US";
import { koKR } from "./messages/ko-KR";

export const SUPPORTED_LOCALES = ["ko-KR", "en-US"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type MessageValues = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, values?: MessageValues) => string;

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  "en-US": enUS,
  "ko-KR": koKR,
};

export function normalizeLocale(value?: string | null): Locale | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko-KR";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return undefined;
}

export const resolveLocale = (saved?: string | null, accepted?: string | null): Locale =>
  normalizeLocale(saved)
  ?? accepted?.split(",").map((part) => normalizeLocale(part.split(";")[0])).find(Boolean)
  ?? "en-US";

const interpolate = (message: string, values?: MessageValues) => values
  ? message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]))
  : message;

export const translate = (locale: Locale, key: MessageKey, values?: MessageValues) =>
  interpolate(dictionaries[locale][key] ?? enUS[key], values);

export function translatePlural(
  locale: Locale,
  keys: Readonly<{ one: MessageKey; other: MessageKey }>,
  count: number,
  values: MessageValues = {},
) {
  const category = new Intl.PluralRules(locale).select(count);
  return translate(locale, category === "one" ? keys.one : keys.other, { ...values, count });
}

export const formatDate = (locale: Locale, value: Date | string | number, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, options ?? { dateStyle: "medium" }).format(new Date(value));

export const formatTime = (locale: Locale, value: Date | string | number, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, options ?? { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));

export const formatNumber = (locale: Locale, value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(locale, options).format(value);

export function formatRelative(locale: Locale, value: Date | string | number, now = Date.now()) {
  const deltaSeconds = (new Date(value).getTime() - now) / 1_000;
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, candidate]) => Math.abs(deltaSeconds) >= candidate) ?? units.at(-1)!;
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(deltaSeconds / size), unit);
}
