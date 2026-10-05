"use client";

import { useEffect } from "react";
import { installSentryErrorTracking } from "@/lib/sentry";

export function SentryInit() {
  useEffect(() => {
    installSentryErrorTracking();
  }, []);
  return null;
}
