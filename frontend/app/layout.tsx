import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import { I18nProvider } from "@/components/i18n-provider";
import { resolveLocale } from "@/i18n/core";
import "./globals.css";
import "./studio-legacy.css";
import "./studio-system.css";

export const metadata: Metadata = {
  title: "Harnest Studio",
  description: "Design, validate, and run an AI agent harness.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale(
    cookieStore.get("harnest.studio.locale")?.value,
    requestHeaders.get("accept-language"),
  );
  return (
    <html lang={locale} suppressHydrationWarning>
      <body><I18nProvider initialLocale={locale}>{children}</I18nProvider></body>
    </html>
  );
}
