"use client";

import { useEffect } from "react";
import { initSentry } from "@/lib/sentry";

export function SentryInit() {
  useEffect(() => {
    initSentry();
  }, []);
  return null;
}
