"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { Icon } from "@/design/icons/icon";
import { Kbd } from "@/design/primitives/kbd";
import { Kicker } from "@/design/primitives/kicker";

export interface HelpShortcut {
  keys: string;
  desc: string;
}

export interface HelpContent {
  /** One-paragraph "what this page does". */
  summary: string;
  /** Primary actions available on the page. */
  actions?: string[];
  /** Keyboard shortcuts (keys + what they do). */
  shortcuts?: HelpShortcut[];
  /** Repo-relative doc path (e.g. `docs/guides/pipeline.md`). When set, the
   *  popover shows a "Learn more" link that opens the Docs hub on that file. */
  docPath?: string;
  /** Override label for the docs deep-link (default "Learn more in docs"). */
  docLabel?: string;
}

export interface HelpButtonProps extends HelpContent {
  /** Visible button label (default "Help"). */
  label?: string;
}

/** Reusable contextual help: an icon+label button that toggles a closeable
 *  popover describing the page, its primary actions, and keyboard shortcuts.
 *  Composed from kit primitives + semantic tokens; a11y wired (aria-haspopup /
 *  aria-expanded, Esc + click-away close, focus returns to the trigger). */
export function HelpButton({
  label = "Help",
  summary,
  actions,
  shortcuts,
  docPath,
  docLabel = "Learn more in docs",
}: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] font-semibold transition-colors",
          "text-muted hover:bg-hover hover:text-fg",
        )}
      >
        <Icon name="help" size={15} />
        {label}
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={panelId}
          role="dialog"
          aria-label="Page help"
          className="forge-drop absolute right-0 top-[calc(100%+6px)] z-50 w-[320px] overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-4 py-2.5">
            <span className="fg-label inline-flex items-center gap-1.5">
              <Icon name="help" size={15} className="text-subtle" />
              About this page
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Close help"
              className="inline-flex size-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="fg-body-sm text-muted">{summary}</p>

            {actions && actions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Kicker>Primary actions</Kicker>
                <ul className="flex flex-col gap-1">
                  {actions.map((a) => (
                    <li key={a} className="fg-body-sm flex items-start gap-2 text-fg">
                      <Icon name="chevronRight" size={14} className="mt-0.5 flex-none text-subtle" />
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {shortcuts && shortcuts.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Kicker>Keyboard shortcuts</Kicker>
                <ul className="flex flex-col gap-1.5">
                  {shortcuts.map((s) => (
                    <li key={s.keys} className="flex items-center justify-between gap-2">
                      <span className="fg-body-sm text-muted">{s.desc}</span>
                      <Kbd>{s.keys}</Kbd>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {docPath && (
              <Link
                href={`/docs?path=${encodeURIComponent(docPath)}`}
                onClick={() => setOpen(false)}
                className="fg-body-sm inline-flex items-center gap-1.5 font-semibold text-[color:var(--link)] hover:underline"
              >
                <Icon name="book" size={14} />
                {docLabel}
                <Icon name="chevronRight" size={14} />
              </Link>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
