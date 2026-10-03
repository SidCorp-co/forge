"use client";

// The peek beside a list (`?peek=KEY`): a summary of one row — its header, whose turn it is and the
// facts that decide it — with "Open full page ↗", ↑/↓ and j/k through the visible rows, Esc to close.
// The URL holds which row is open, written with replaceState, so opening, closing and moving never
// stack history entries and back from the full page reopens the same peek. From 1024px it sits
// beside the list and the list stays live; below that it is a full-screen sheet named after the list.

import type { ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { Button } from "../primitives/button";
import { IconButton } from "../primitives/icon-button";
import { Kbd } from "../primitives/kbd";
import { useUrlParams } from "../hooks/use-url-params";

export interface PeekState {
  /** The open row's key, when it is one of `keys`. */
  open: string | null;
  /** 1-based position among the visible rows, or null when the open row is folded away. */
  position: { at: number; of: number } | null;
  set: (key: string | null) => void;
  move: (by: number) => void;
}

/** `?peek=` over the rows the reader can see, in their visible order. */
export function usePeek(keys: readonly string[], allKeys: readonly string[] = keys): PeekState {
  const [params, setParams] = useUrlParams();
  const raw = params.get("peek");
  const open = raw && allKeys.includes(raw) ? raw : null;
  const set = useCallback((key: string | null) => setParams({ peek: key }), [setParams]);
  const at = open ? keys.indexOf(open) : -1;
  const move = useCallback(
    (by: number) => {
      const i = open ? keys.indexOf(open) : -1;
      const next = i < 0 ? keys[0] : keys[i + by];
      if (next) setParams({ peek: next });
    },
    [keys, open, setParams],
  );
  return { open, position: at >= 0 ? { at: at + 1, of: keys.length } : null, set, move };
}

/** j/k (and ↓/↑) move, Enter opens the full page, Esc closes — never while typing in a field. */
export function usePeekKeys(peek: PeekState, onOpenFull: (key: string) => void): void {
  useEffect(() => {
    if (!peek.open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") peek.set(null);
      else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        peek.move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        peek.move(-1);
      } else if (e.key === "Enter" && (e.target === document.body || el?.dataset.peekRoot === "1")) onOpenFull(peek.open as string);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek, onOpenFull]);
}

export interface PeekPanelProps {
  peek: PeekState;
  /** The list's name, on the back control of the narrow-screen sheet: "← Issues". */
  listLabel: string;
  /** What kind of item this is, before its key: "Issue", "Requirement", "Feedback". */
  noun: string;
  onOpenFull: () => void;
  children: ReactNode;
  testId?: string;
}

export function PeekPanel({ peek, listLabel, noun, onOpenFull, children, testId }: PeekPanelProps) {
  const pos = peek.position;
  return (
    <aside
      className="fixed inset-0 z-30 flex flex-col overflow-y-auto border-line-subtle bg-surface lg:sticky lg:inset-auto lg:top-0 lg:z-auto lg:h-[calc(100dvh-48px)] lg:border-l"
      aria-label={`${noun} ${peek.open ?? ""} summary`}
      data-testid={testId ?? "peek-panel"}
      data-peek-root="1"
    >
      <div className="sticky top-0 z-[3] flex items-center gap-1.5 border-b border-line-subtle bg-surface px-3 py-2">
        <Button type="button" size="sm" className="lg:hidden" onClick={() => peek.set(null)} data-testid="peek-back">
          ← {listLabel}
        </Button>
        <IconButton icon="arrowUp" size="sm" aria-label={`Previous ${noun.toLowerCase()} (k)`} disabled={!pos || pos.at <= 1} onClick={() => peek.move(-1)} />
        <IconButton icon="arrowDown" size="sm" aria-label={`Next ${noun.toLowerCase()} (j)`} disabled={!pos || pos.at >= pos.of} onClick={() => peek.move(1)} />
        {pos ? (
          <span className="mx-1 whitespace-nowrap font-mono text-11 text-subtle" data-testid="peek-position">
            {pos.at} of {pos.of}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button type="button" size="sm" onClick={onOpenFull} data-testid="open-full-page">
          Open full page ↗
        </Button>
        <IconButton icon="x" size="sm" aria-label="Close (Esc)" onClick={() => peek.set(null)} />
      </div>
      <div className="flex flex-1 shrink-0 flex-col">{children}</div>
      <div className="mt-auto border-t border-line-subtle px-[18px] pb-4 pt-2.5 text-12 text-subtle max-lg:hidden">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> full page · <Kbd>Esc</Kbd> close
      </div>
    </aside>
  );
}

export interface PeekHeadProps {
  noun: string;
  itemKey: string;
  badge?: ReactNode;
  title: ReactNode;
  /** The one primary act, the same the full page's header offers. */
  action?: ReactNode;
}

/** The peek's header: kind, key and state, the title, and the one primary act. */
export function PeekHead({ noun, itemKey, badge, title, action }: PeekHeadProps) {
  return (
    <div className="px-[18px] pb-3 pt-3.5" data-testid="peek-head">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-12 text-subtle">{noun}</span>
        <span className="font-mono text-12 font-semibold text-link">{itemKey}</span>
        {badge}
      </div>
      <h2 className="mt-1.5 text-[17px] font-semibold leading-snug text-fg">{title}</h2>
      {action ? <div className="mt-2.5 flex flex-wrap gap-2 empty:hidden">{action}</div> : null}
    </div>
  );
}
