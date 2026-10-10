"use client";

// A flush section of any page: its heading in type with an optional act at its right, its body under
// it, a hairline between it and the section before. No frame, no fill, no shadow: the heading and the
// whitespace set it off. `PropertyList` is the label-and-value body a section holds most often.

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function Section({
  title,
  right,
  children,
  id,
  testId,
  className,
  ...rest
}: { title?: ReactNode; right?: ReactNode; children?: ReactNode; id?: string; testId?: string; className?: string } & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  return (
    <section {...rest} id={id} className={cn("scroll-mt-24 border-t border-line-subtle py-5 first:border-t-0 first:pt-0", className)} data-testid={testId}>
      {title || right ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          {title ? <h2 className="text-15 font-bold leading-snug text-accent-text">{title}</h2> : null}
          {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Label-and-value rows in a page's main column; the rail's narrower kin is `Fact`. */
export function PropertyList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <dl className="divide-y divide-line-subtle" data-testid={testId}>
      {children}
    </dl>
  );
}

export function Property({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)] items-baseline gap-3 py-2 text-13 max-md:grid-cols-1 max-md:gap-0.5" data-testid={testId}>
      <dt className="text-12-5 font-medium text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-fg">{children}</dd>
    </div>
  );
}
