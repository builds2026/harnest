export const isLiteralLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "[::1]";

const configuredHosts = () => new Set((process.env.HARNEST_STUDIO_ALLOWED_HOSTS ?? "")
  .split(",").map((host) => host.trim().toLocaleLowerCase()).filter(Boolean));

export const isAllowedStudioHostname = (hostname: string): boolean =>
  isLiteralLoopbackHostname(hostname) || configuredHosts().has(hostname.toLocaleLowerCase());

export function hasLiteralStudioHost(request: Pick<Request, "headers" | "url">): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const authority = new URL(`http://${host}`);
    if (!isAllowedStudioHostname(authority.hostname)
      || authority.host.toLocaleLowerCase() !== host.toLocaleLowerCase()) return false;
    const url = new URL(request.url);
    const normalizedBindHost = process.env.HARNEST_STUDIO_HOST === "0.0.0.0"
      && (url.hostname === "0.0.0.0" || url.hostname === "localhost");
    // NextURL may normalize the browser-visible Host to localhost or the server's wildcard bind address.
    // The raw Host remains authoritative and has already passed the exact allowlist above.
    return (url.hostname === authority.hostname
      || (isLiteralLoopbackHostname(authority.hostname) && url.hostname === "localhost")
      || normalizedBindHost)
      && url.port === authority.port;
  } catch {
    return false;
  }
}
