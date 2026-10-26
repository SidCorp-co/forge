"use client";

import { usePageTitle } from "@/lib/document-title";

export function TabTitle({ subject }: { subject: string }) {
  usePageTitle(subject);
  return null;
}
