"use client";

import { type HTMLAttributes, useLayoutEffect, useRef, useState } from "react";
import { usePageTitle } from "@/lib/document-title";

export function TabTitle({ subject }: { subject: string }) {
  usePageTitle(subject);
  return null;
}

/** The page's h1, naming the tab with the text it shows: one element says both, so they cannot disagree (ISS-1229 r47). */
export function TabNamingHeading(props: HTMLAttributes<HTMLHeadingElement>) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [subject, setSubject] = useState<string | null>(null);
  useLayoutEffect(() => {
    const shown = ref.current?.textContent?.replace(/\s+/g, " ").trim() || null;
    if (shown !== subject) setSubject(shown);
  });
  usePageTitle(subject);
  return <h1 ref={ref} {...props} />;
}
