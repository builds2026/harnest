import type { ReactNode } from "react";
import Studio from "@/components/studio";

export default function StudioLayout({ children: _children }: Readonly<{ children: ReactNode }>) {
  return <Studio />;
}
