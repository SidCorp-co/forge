"use client";

import { useEffect } from "react";
import { initSentry } from "@/lib/sentry";

/**
 * Mounts once in the root layout to initialize the optional Sentry client SDK
 * (no-op unless `NEXT_PUBLIC_SENTRY_DSN` was set at build time). Renders nothing.
 */
export function SentryInit() {
  useEffect(() => {
    initSentry();
  }, []);
  return null;
}
