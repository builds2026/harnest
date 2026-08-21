import { NextResponse, type NextRequest } from "next/server";
import { hasLiteralStudioHost } from "./lib/studio-host";

export function proxy(request: NextRequest): NextResponse {
  if (!hasLiteralStudioHost(request)) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }
  return NextResponse.next();
}
