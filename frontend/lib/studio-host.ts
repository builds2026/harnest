export const isLiteralLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "[::1]";

export function hasLiteralStudioHost(request: Pick<Request, "headers" | "url">): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const authority = new URL(`http://${host}`);
    if (!isLiteralLoopbackHostname(authority.hostname)
      || authority.host.toLocaleLowerCase() !== host.toLocaleLowerCase()) return false;
    const url = new URL(request.url);
    // NextURL normalizes every loopback IP to `localhost`; the raw Host header remains authoritative.
    return (url.hostname === authority.hostname || url.hostname === "localhost")
      && url.port === authority.port;
  } catch {
    return false;
  }
}
