"use client";

// Every entity list draws this one grid: Key · Title (with one secondary facts line) · State ·
// Waiting on · [ETA] · Owner·age, grouped under sticky headers that read label-first ("Needs you 4") and
// fold. A row is a link to its full page: a plain click opens the peek, a modified click (Cmd, Ctrl,
// Shift, middle) goes to the page as the browser would. Folded groups live in session storage, so
// back from a full page finds them as they were.

import type { StandingGroup, StandingGroupLabels } from "@forge/contracts/standing";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "../icons/icon";
import { LEGEND, type LegendTone } from "../vocabulary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useReportShown } from "../hooks/use-page-shown";

/** A read model's groups in the order its contract declares them, each holding the rows core put there. */
export function standingGroups<R extends { attentionGroup: G }, G extends StandingGroup>(
  rows: readonly R[],
  order: readonly G[],
  labels: StandingGroupLabels<G>,
): ListGroup<R>[] {
  return order.map((g) => ({ id: g, ...labels[g], rows: rows.filter((r) => r.attentionGroup === g) }));
}

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
  /** Drawn in the key column in place of `key` (a path that wraps at its slashes, say); `key` stays the row's identity. */
  keyLabel?: ReactNode;
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
  /** The ETA cell, drawn where the list declares an ETA column. */
  eta?: ReactNode;
  /** A sentence under the facts line that wraps instead of being cut: what the row's act changes. */
  note?: ReactNode;
}

/** One grid template for the header and every row, so the columns line up without a table. */
const COLS =
  "grid grid-cols-[104px_minmax(0,1fr)_168px_220px_118px] gap-x-3.5 px-5 max-xl:grid-cols-[96px_minmax(0,1fr)_150px_196px_104px] max-lg:grid-cols-[92px_minmax(0,1fr)_144px_180px]";
/** The same grid with the ETA column between Waiting on and Owner·age. */
const COLS_ETA =
  "grid grid-cols-[104px_minmax(0,1fr)_168px_200px_128px_118px] gap-x-3.5 px-5 max-xl:grid-cols-[96px_minmax(0,1fr)_150px_180px_120px_104px] max-lg:grid-cols-[92px_minmax(0,1fr)_144px_164px_112px]";

/** Rows in each group ordered by `value`, lowest first and every row without one last, in their own order. */
export function sortGroupsBy<R>(groups: readonly ListGroup<R>[], value: (r: R) => number | null): ListGroup<R>[] {
  return groups.map((g) => {
    const keyed = g.rows.map((r, i) => ({ r, i, v: value(r) }));
    keyed.sort((a, b) => (a.v === null ? (b.v === null ? a.i - b.i : 1) : b.v === null ? -1 : a.v - b.v || a.i - b.i));
    return { ...g, rows: keyed.map((k) => k.r) };
  });
}

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

function Row({ v, selected, onPeek, eta }: { v: ListRowView; selected: boolean; onPeek: (key: string) => void; eta: boolean }) {
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
        eta ? COLS_ETA : COLS,
        "relative min-h-[54px] w-full cursor-pointer items-center border-b border-line-subtle py-[7px] text-left text-fg no-underline hover:bg-hover",
        "max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-y-1 max-md:px-3 max-md:py-2.5",
        selected && "bg-[var(--cobalt-50)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-link hover:bg-[var(--cobalt-50)]",
      )}
    >
      <span className={cn("truncate font-mono text-11-5 font-semibold text-link max-md:order-1", v.dim && "opacity-65")}>{v.keyLabel ?? v.key}</span>
      <span className="flex min-w-0 flex-col max-md:order-3 max-md:col-span-3">
        <span className={cn("truncate text-13-5 font-medium max-md:whitespace-normal", v.dim && "opacity-65")}>{v.title}</span>
        {v.facts.length ? (
          // one line that ends in an ellipsis: inline parts never shrink into each other
          <span className="block min-w-0 truncate text-12 text-subtle" data-testid="row-facts">
            {v.facts.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the facts line is positional
              <span key={i} className="whitespace-nowrap">
                {i > 0 ? <span className="mx-1.5 text-[var(--paper-400)]">·</span> : null}
                {p}
              </span>
            ))}
          </span>
        ) : null}
        {v.note ? (
          <span className="mt-0.5 block text-12 text-muted" data-testid="row-note">
            {v.note}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 max-md:order-2 max-md:col-span-2 max-md:justify-end">{v.state}</span>
      <span className="flex min-w-0 max-md:order-4 max-md:col-span-2">{v.waitingOn}</span>
      {eta ? <span className="flex min-w-0 justify-end max-md:order-6 max-md:col-span-3 max-md:justify-start">{v.eta}</span> : null}
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

export interface ListColumnLabels {
  key: string;
  title: string;
  state: string;
  waitingOn: string;
  meta: string;
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
  /** The header's words where a list's columns are not the entity default: Key · Title · State · Waiting on · Owner · age. */
  columns?: Partial<ListColumnLabels>;
  /** An ETA column: its header, and whether the rows are sorted by it, which its header toggles. */
  eta?: { label: string; sortLabel: string; sorted: boolean; onSort: () => void };
}

export function GroupedList<R>({ ariaLabel, groups, fold, row, selected, onPeek, empty, columns, eta }: GroupedListProps<R>) {
  const t = useCopy();
  const shown = groups.filter((g) => g.rows.length > 0);
  // each open group's rows, viewed once: drawn below and reported as what the list shows (REQ-41 BC-8)
  const drawn = shown.map((g) => {
    const open = fold.isOpen(g.id, g.collapsed);
    return { g, open, views: open ? g.rows.map(row) : [] };
  });
  useReportShown(drawn.flatMap((d) => d.views.map((v) => v.key)));
  return (
    <section aria-label={ariaLabel} data-testid="grouped-list">
      <div
        className={cn(eta ? COLS_ETA : COLS, "sticky top-0 z-[6] h-8 items-center border-b border-line-subtle bg-sunken text-11-5 font-semibold text-subtle max-md:hidden")}
        data-testid="list-header"
      >
        <span aria-hidden>{columns?.key ?? t("list.col.key")}</span>
        <span aria-hidden>{columns?.title ?? t("list.col.title")}</span>
        <span aria-hidden>{columns?.state ?? t("list.col.state")}</span>
        <span aria-hidden>{columns?.waitingOn ?? t("list.col.waitingOn")}</span>
        {eta ? (
          <button
            type="button"
            onClick={eta.onSort}
            aria-pressed={eta.sorted}
            title={eta.sortLabel}
            data-testid="list-sort-eta"
            className={cn("inline-flex items-center justify-end gap-1 justify-self-end text-right hover:text-fg", eta.sorted && "text-fg")}
          >
            {eta.label}
            <Icon name={eta.sorted ? "arrowUp" : "chevronUpDown"} size={11} />
          </button>
        ) : null}
        <span aria-hidden className="text-right max-lg:hidden">{columns?.meta ?? t("list.col.meta")}</span>
      </div>
      {shown.length === 0 ? <p className="px-5 py-8 text-13 text-subtle">{empty ?? t("list.empty")}</p> : null}
      {drawn.map(({ g, open, views }) => (
        <div key={g.id}>
          <GroupHeader g={g} open={open} onToggle={() => fold.toggle(g.id, g.collapsed)} />
          {views.map((v) => (
            <Row key={v.key} v={v} selected={v.key === selected} onPeek={onPeek} eta={eta !== undefined} />
          ))}
        </div>
      ))}
    </section>
  );
}
