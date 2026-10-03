"use client";

// A full page's body: a main column whose views are tabs (`?tab=`) under a tab bar that sticks below
// the top bar, beside the facts rail. Tabs replace an endless scroll of numbered zones; switching a tab
// opened from below the fold starts the new view at its own top, under the sticky bar.

import type { ReactNode } from "react";
import { useCallback, useRef } from "react";
import { useUrlChoice } from "../hooks/use-url-params";
import { Tabs } from "../primitives/tabs";

/** `?tab=` over a fixed set of views; the first is the default and is not written to the URL. */
export function useUrlTab<T extends string>(tabs: readonly T[]): [T, (t: T) => void] {
  return useUrlChoice("tab", tabs, tabs[0] as T);
}

export interface DetailTabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export interface DetailTabsProps<T extends string> {
  tabs: readonly DetailTabItem<T>[];
  value: T;
  onChange: (t: T) => void;
  testId?: string;
}

export function DetailTabs<T extends string>({ tabs, value, onChange, testId }: DetailTabsProps<T>) {
  const top = useRef<HTMLDivElement>(null);
  const go = useCallback(
    (t: string) => {
      onChange(t as T);
      const el = top.current;
      const floor = el?.closest("main")?.getBoundingClientRect().top ?? 0;
      if (el && el.getBoundingClientRect().top < floor) el.scrollIntoView({ block: "start" });
    },
    [onChange],
  );
  return (
    <>
      <div ref={top} />
      <div className="sticky top-0 z-10 overflow-x-auto bg-surface px-6 max-md:px-2" data-testid={testId ?? "detail-tabs"}>
        <Tabs tabs={tabs.map((t) => ({ ...t }))} value={value} onChange={go} />
      </div>
    </>
  );
}

/** The page grid: main column and the facts rail beside it (under it below 1024px). */
export function DetailLayout({ children, rail, testId, dataKey }: { children: ReactNode; rail: ReactNode; testId?: string; dataKey?: string }) {
  return (
    <article className="grid min-h-[calc(100dvh-48px)] bg-surface lg:grid-cols-[minmax(0,1fr)_320px]" data-testid={testId} data-key={dataKey}>
      <div className="min-w-0">{children}</div>
      {rail}
    </article>
  );
}

/** A tab's view: one column of readable width. */
export function DetailPane({ children, label, testId }: { children: ReactNode; label: string; testId?: string }) {
  return (
    <section className="mx-auto max-w-[860px] px-8 pb-16 pt-6 max-md:px-4" aria-label={label} data-testid={testId}>
      {children}
    </section>
  );
}
