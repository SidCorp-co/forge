"use client";

// The `/`-autocomplete panel for the chat composer (ISS-718). It lists the
// project's install-only skills and reports which one was chosen; inserting the
// text into the message is the composer's job, and running it needs no new
// contract at all — a resumed turn forwards the message to the CLI verbatim, so
// `/skill-name` reaches Claude exactly as if it had been typed by hand.
//
// Never rendered as an inert control: the composer hides its trigger entirely
// when the project has no invokable skills, so "nothing here" is a state this
// panel only reaches on a race, not by design.

import { useEffect, useRef } from "react";
import { Icon, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import type { InvokableSkill } from "@/features/skills/types";
import { useAnchoredMenu } from "./anchored-menu";

export interface SlashSkillsSource {
  /** The project's invokable skills; empty while loading or on error. */
  items: InvokableSkill[];
  loading: boolean;
  error: unknown;
  retry: () => void;
}

interface SlashSkillsMenuProps extends SlashSkillsSource {
  open: boolean;
  onClose: () => void;
  /** The token text after the `/`, echoed in the filtered-empty line. */
  query: string;
  /** Already filtered by the caller (it owns the token). */
  matches: InvokableSkill[];
  /** Index into `matches` that ↑/↓ moved to. */
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (skill: InvokableSkill) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function SlashSkillsMenu({
  open,
  onClose,
  query,
  matches,
  highlight,
  onHighlight,
  onPick,
  items,
  loading,
  error,
  retry,
  anchorRef,
}: SlashSkillsMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenu({
    open,
    onClose,
    anchorRef,
    width: 360,
    placement: "above",
    maxHeight: 280,
  });

  // cm:guard feature-test scrollIntoView instead of calling it blind — keeping the cursor in view is a nicety, and an environment without the method (jsdom) must still get a working menu rather than a crash inside an effect
  // cm:guard index the row off `highlight` rather than querying a `[data-active]` attribute, so the dependency is genuinely read in the effect — otherwise a lint fix drops it from the deps and the panel silently stops following the cursor
  useEffect(() => {
    if (!open) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    const el = rows?.[highlight];
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label="Insert a skill"
      style={{
        top: pos?.top,
        left: pos?.left,
        width: pos?.width,
        visibility: pos ? undefined : "hidden",
      }}
      className="forge-drop fixed z-50 max-h-[280px] overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-lg"
      ref={listRef}
    >
      <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-subtle">
        Skills
      </div>

      {loading && (
        <div className="space-y-1.5 px-2 py-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1">
              <Skeleton variant="text" className="w-1/3" />
              <Skeleton variant="text" className="w-3/4" />
            </div>
          ))}
        </div>
      )}

      {!loading && !!error && (
        <div className="px-2 py-2">
          <p className="text-[12px] text-fg">Couldn&apos;t load skills.</p>
          <p className="text-[11px] text-subtle">{formatApiError(error)}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-1.5 rounded-md border border-line px-2 py-1 text-[12px] text-fg transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="px-2 py-2 text-[12px] text-subtle">
          No skills are invokable here yet — add one in Skills.
        </p>
      )}

      {!loading && !error && items.length > 0 && matches.length === 0 && (
        <p className="px-2 py-2 text-[12px] text-subtle">
          No skill matches &ldquo;{query}&rdquo;. Keep typing to send it as text.
        </p>
      )}

      {!loading &&
        !error &&
        matches.map((skill, i) => (
          <button
            key={skill.name}
            type="button"
            role="option"
            aria-selected={i === highlight}
            // cm:why the textarea keeps focus while the menu drives off its keydown, so hover — not focus — is what moves the cursor here
            onMouseEnter={() => onHighlight(i)}
            // cm:guard mousedown, not click: click fires after the textarea's blur handler has closed the menu, and by then the token the insert edits is gone
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(skill);
            }}
            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
              i === highlight ? "bg-hover" : ""
            } hover:bg-hover focus-visible:outline-none`}
          >
            <Icon name="agent" size={13} className="mt-0.5 flex-none text-subtle" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-fg">/{skill.name}</span>
              <span className="line-clamp-2 block text-[11px] text-subtle">
                {skill.description}
              </span>
            </span>
          </button>
        ))}
    </div>
  );
}
