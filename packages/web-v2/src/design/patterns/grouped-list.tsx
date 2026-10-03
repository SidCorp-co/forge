"use client";

// Every entity list draws this one grid: Key · Title (with one secondary facts line) · State ·
// Waiting on · Owner·age, grouped under sticky headers that read label-first ("Needs you 4") and
// fold. A row is a link to its full page: a plain click opens the peek, a modified click (Cmd, Ctrl,
// Shift, middle) goes to the page as the browser would. Folded groups live in session storage, so
// back from a full page finds them as they were.

import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "../icons/icon";
import { LEGEND, type LegendTone } from "../vocabulary";

export interface ListGroup<R> {
  id: string;
  label: ReactNode;
  /** Drawn in mono, for a code path such as a module. */
  mono?: boolean;
  tone?: LegendTone | null;
  hint?: ReactNode;
  /** Label-first counts after the hint, e.g. "Needs you 1 · Moving 1". */
  summary?: { label: string; count: number; tone: LegendTone }[];
  collapsed?: boolean;
  rows: R[];
}

export interface ListRowView {
  key: string;
  /** The full page: the row's link target. */
  href: string;
  title: ReactNode;
  /** The one secondary line under the title; parts are joined by a middle dot. */
  facts: ReactNode[];
  state: ReactNode;
  waitingOn: ReactNode;
  owner: ReactNode;
  age: { text: string; title: string } | null;
  /** Done rows read quieter. */
  dim?: boolean;
}

/** One grid template for the header and every row, so the columns line up without a table. */
const COLS =
  "grid grid-cols-[104px_minmax(0,1fr)_168px_220px_118px] gap-x-3.5 px-5 max-xl:grid-cols-[96px_minmax(0,1fr)_150px_196px_104px] max-lg:grid-cols-[92px_minmax(0,1fr)_144px_180px]";

export type GroupFold = {
  isOpen: (id: string, collapsedByDefault?: boolean) => boolean;
  toggle: (id: string, collapsedByDefault?: boolean) => void;
};

/** The fold state of one list's groups, kept per tab session under `storageKey`. */
export function useGroupFold(storageKey: string): GroupFold {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      setFolded(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setFolded({});
    }
  }, [storageKey]);
  const isOpen = useCallback((id: string, collapsedByDefault = false) => !(folded[id] ?? collapsedByDefault), [folded]);
  const toggle = useCallback(
    (id: string, collapsedByDefault = false) =>
      setFolded((f) => {
        const next = { ...f, [id]: !(f[id] ?? collapsedByDefault) };
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      }),
    [storageKey],
  );
  return { isOpen, toggle };
}

/** The rows a reader can step through with j/k: every row of an open group, in order. */
export function visibleRows<R>(groups: readonly ListGroup<R>[], fold: GroupFold): R[] {
  return groups.flatMap((g) => (fold.isOpen(g.id, g.collapsed) ? g.rows : []));
}

const toneText = (t: LegendTone | null | undefined) => (!t || t === "neutral" || t === "done" ? "var(--fg-muted)" : LEGEND[t].fg);

function GroupHeader<R>({ g, open, onToggle }: { g: ListGroup<R>; open: boolean; onToggle: () => void }) {
  const c = toneText(g.tone);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-testid="list-group"
      data-group={g.id}
      className="sticky top-8 z-[5] flex min-h-[34px] w-full flex-wrap items-center gap-x-2 gap-y-0.5 bg-sunken px-5 py-[5px] text-left text-13 max-md:top-0 max-md:px-3"
    >
      <Icon name="chevronDown" size={12} className={cn("text-subtle transition-transform duration-150", !open && "-rotate-90")} />
      <span className={cn("font-bold", g.mono && "font-mono text-12-5 font-semibold")} style={{ color: g.mono ? "var(--fg-default)" : c }}>
        {g.label}
      </span>
      <span className="font-mono text-12 font-bold" style={{ color: g.mono ? "var(--fg-muted)" : c }}>
        {g.rows.length}
      </span>
      {g.hint ? <span className="text-12 font-medium text-subtle">{g.hint}</span> : null}
      {g.summary?.map((s) => (
        <span key={s.label} className="text-11-5 font-semibold" style={{ color: toneText(s.tone) }}>
          {s.label} {s.count}
        </span>
      ))}
    </button>
  );
}

const modified = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

function Row({ v, selected, onPeek }: { v: ListRowView; selected: boolean; onPeek: (key: string) => void }) {
  return (
    <a
      href={v.href}
      onClick={(e) => {
        if (modified(e)) return;
        e.preventDefault();
        onPeek(v.key);
      }}
      aria-current={selected ? "true" : undefined}
      data-testid="list-row"
      data-key={v.key}
      className={cn(
        COLS,
        "relative min-h-[54px] w-full cursor-pointer items-center border-b border-line-subtle py-[7px] text-left text-fg no-underline hover:bg-hover",
        "max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-y-1 max-md:px-3 max-md:py-2.5",
        selected && "bg-[var(--cobalt-50)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-link hover:bg-[var(--cobalt-50)]",
      )}
    >
      <span className={cn("truncate font-mono text-11-5 font-semibold text-link max-md:order-1", v.dim && "opacity-65")}>{v.key}</span>
      <span className="flex min-w-0 flex-col max-md:order-3 max-md:col-span-3">
        <span className={cn("truncate text-13-5 font-medium max-md:whitespace-normal", v.dim && "opacity-65")}>{v.title}</span>
        {v.facts.length ? (
          <span className="flex min-w-0 items-center truncate text-12 text-subtle" data-testid="row-facts">
            {v.facts.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the facts line is positional
              <span key={i} className="inline-flex min-w-0 items-center">
                {i > 0 ? <span className="mx-1.5 text-[var(--paper-400)]">·</span> : null}
                {p}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 max-md:order-2 max-md:col-span-2 max-md:justify-end">{v.state}</span>
      <span className="flex min-w-0 max-md:order-4 max-md:col-span-2">{v.waitingOn}</span>
      <span className="flex min-w-0 items-center justify-end gap-2 whitespace-nowrap max-lg:hidden max-md:order-5 max-md:flex">
        <span className="inline-flex min-w-0 items-center text-12 text-muted">{v.owner}</span>
        {v.age ? (
          <span className="font-mono text-11 text-subtle" title={v.age.title}>
            {v.age.text}
          </span>
        ) : null}
      </span>
    </a>
  );
}

export interface GroupedListProps<R> {
  ariaLabel: string;
  groups: readonly ListGroup<R>[];
  fold: GroupFold;
  row: (r: R) => ListRowView;
  selected: string | null;
  onPeek: (key: string) => void;
  /** Said where no group has a row, e.g. "Nothing matches this search." */
  empty?: ReactNode;
}

export function GroupedList<R>({ ariaLabel, groups, fold, row, selected, onPeek, empty }: GroupedListProps<R>) {
  const shown = groups.filter((g) => g.rows.length > 0);
  return (
    <section aria-label={ariaLabel} data-testid="grouped-list">
      <div
        aria-hidden
        className={cn(COLS, "sticky top-0 z-[6] h-8 items-center border-b border-line-subtle bg-app text-11-5 font-semibold text-subtle max-md:hidden")}
      >
        <span>Key</span>
        <span>Title</span>
        <span>State</span>
        <span>Waiting on</span>
        <span className="text-right max-lg:hidden">Owner · age</span>
      </div>
      {shown.length === 0 ? <p className="px-5 py-8 text-13 text-subtle">{empty ?? "Nothing to show."}</p> : null}
      {shown.map((g) => {
        const open = fold.isOpen(g.id, g.collapsed);
        return (
          <div key={g.id}>
            <GroupHeader g={g} open={open} onToggle={() => fold.toggle(g.id, g.collapsed)} />
            {open
              ? g.rows.map((r) => {
                  const v = row(r);
                  return <Row key={v.key} v={v} selected={v.key === selected} onPeek={onPeek} />;
                })
              : null}
          </div>
        );
      })}
    </section>
  );
}
