"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  formatDate as formatLocaleDate,
  formatNumber as formatLocaleNumber,
  formatRelative as formatLocaleRelative,
  formatTime as formatLocaleTime,
  resolveLocale,
  translate,
  translatePlural,
  type Locale,
  type MessageValues,
} from "@/i18n/core";
import type { MessageKey } from "@/i18n/messages/en-US";

const LOCALE_COOKIE = "harnest.studio.locale";

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey, values?: MessageValues) => string;
  readonly tp: (keys: Readonly<{ one: MessageKey; other: MessageKey }>, count: number, values?: MessageValues) => string;
  readonly formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly formatRelative: (value: Date | string | number, now?: number) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const detected = resolveLocale(document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`))?.[1], navigator.languages?.join(",") ?? navigator.language);
    if (detected !== locale) setLocaleState(detected);
  }, []); // The server value is authoritative unless the first browser visit has a more specific locale.

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.documentElement.lang = next;
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
    tp: (keys, count, values) => translatePlural(locale, keys, count, values),
    formatDate: (input, options) => formatLocaleDate(locale, input, options),
    formatTime: (input, options) => formatLocaleTime(locale, input, options),
    formatNumber: (input, options) => formatLocaleNumber(locale, input, options),
    formatRelative: (input, now) => formatLocaleRelative(locale, input, now),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
