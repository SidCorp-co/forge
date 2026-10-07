"use client";

// The one line of signals under a list's title: label-first facts on the surface tone, a hairline
// under them, never a row of cards. Each value names its source on hover.

import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";

export function SignalsStrip({ children, label, testId }: { children: ReactNode; label?: string; testId?: string }) {
  const t = useCopy();
  return (
    <div className="border-b border-line-subtle bg-surface" data-testid={testId ?? "signals-strip"}>
      <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-5 py-2.5 max-md:px-3" aria-label={label ?? t("overview.signal.signals")}>
        {children}
      </dl>
    </div>
  );
}

export function Signal({ label, children, title, testId }: { label: string; children: ReactNode; title?: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2" data-testid={testId} title={title}>
      <dt className="whitespace-nowrap text-12-5 font-medium text-muted">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-1.5 text-12-5 text-fg">{children}</dd>
    </div>
  );
}
