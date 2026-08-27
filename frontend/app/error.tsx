"use client";

import { RouteError } from "@/components/route-state";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError digest={error.digest} onRetry={retry} />;
}
