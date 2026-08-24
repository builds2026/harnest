export type StudioSurface = "builder" | "playground" | "runs" | "integrate" | "settings";

export const STUDIO_SURFACE_HREFS: Readonly<Record<StudioSurface, string>> = {
  builder: "/builder",
  playground: "/playground",
  runs: "/runs",
  integrate: "/integrate",
  settings: "/settings",
};

export function surfaceFromPathname(pathname: string): StudioSurface {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment === "playground" || segment === "runs" || segment === "integrate" || segment === "settings"
    ? segment
    : "builder";
}
