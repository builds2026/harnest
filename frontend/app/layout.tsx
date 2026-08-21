import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harnest Studio",
  description: "Design, validate, and run an AI agent harness.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
