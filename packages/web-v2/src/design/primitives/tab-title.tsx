"use client";

import { usePageTitle } from "@/lib/document-title";

/** Names the browser tab after what the page says, while it is shown; renders nothing (ISS-1229 r44). */
export function TabTitle({ subject }: { subject: string }) {
  usePageTitle(subject);
  return null;
}
