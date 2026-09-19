"use client";


import { useEffect } from "react";
import { Icon, Skeleton, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import type { InvokableSkill } from "@/features/skills/types";
import { useAnchoredMenu } from "./anchored-menu";

export interface SlashSkillsSource {
  /** The project's invokable skills; empty while loading or on error. */
  items: InvokableSkill[];
  loading: boolean;
  error: unknown;
  /**
   * A fetch is in flight. Distinct from `loading`, and the difference is the
   * whole point: react-query's `isLoading` is false while REFETCHING a query
   * that is already in `error` status, so a retry press would otherwise
   * re-render the identical error block with nothing to say it was heard.
   */
  fetching: boolean;
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
  /**
   * The panel node, owned by the composer: it needs it to tell a focus move
   * INTO the panel from a focus move away, and the click-away needs it because
   * the panel is not a descendant of the anchor.
   */
  panelRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Focus has been moved INTO the panel (only the error state's Retry is
   * reachable that way) and is now leaving it, or Escape was pressed there.
   * The caller closes and returns focus to the textarea.
   */
  onLeave: (dismissed?: boolean) => void;
  /**
   * Hand focus back to the textarea WITHOUT closing — pressed Retry keeps the
   * panel up to show the outcome, but must not leave focus on a button that a
   * successful retry is about to unmount. React fires no blur for a node
   * removed while focused, so nothing else would notice.
   */
  onReturnFocus: () => void;
  /**
   * The textarea the panel belongs to. Focus arriving THERE is the panel doing
   * its job (a Retry press hands focus back); focus arriving anywhere else —
   * including the send button, which is the next tab stop — means the user has
   * navigated away and the panel must not stay mounted over the conversation.
   */
  homeRef: React.RefObject<HTMLTextAreaElement | null>;
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
  fetching,
  retry,
  anchorRef,
  panelRef,
  onLeave,
  onReturnFocus,
  homeRef,
}: SlashSkillsMenuProps) {
  const pos = useAnchoredMenu({
    open,
    onClose,
    anchorRef,
    panelRef,
    width: 360,
    placement: "above",
  });

  useEffect(() => {
    if (!open) return;
    const rows = panelRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    const el = rows?.[highlight];
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [open, highlight, panelRef]);

  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label="Insert a skill"
      style={{
        top: pos?.top,
        bottom: pos?.bottom,
        left: pos?.left,
        width: pos?.width,
        visibility: pos ? undefined : "hidden",
      }}
      className="forge-drop fixed z-50 max-h-[280px] overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-lg"
      ref={panelRef}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onLeave(true);
        }
      }}
      onBlur={(e) => {
        const rt = e.relatedTarget as Node | null;
        if (panelRef.current?.contains(rt)) return;
        if (rt && rt === homeRef.current) return;
        onLeave();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-2 pb-1 pt-1 text-11 font-medium uppercase tracking-wide text-subtle">
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
          <p className="text-12 text-fg">Couldn&apos;t load skills.</p>
          <p className="text-11 text-subtle">{formatApiError(error)}</p>
          <button
            type="button"
            disabled={fetching}
            onClick={() => {
              onReturnFocus();
              retry();
            }}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-12 text-fg transition-colors hover:bg-hover focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {fetching && <Spinner size={11} />}
            {fetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="px-2 py-2 text-12 text-subtle">
          No skills are invokable here yet — add one in Skills.
        </p>
      )}

      {!loading && !error && items.length > 0 && matches.length === 0 && (
        <p className="px-2 py-2 text-12 text-subtle">
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
            onMouseEnter={() => onHighlight(i)}
            onMouseDown={() => onPick(skill)}
            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
              i === highlight ? "bg-hover" : ""
            } hover:bg-hover focus-visible:outline-none`}
          >
            <Icon name="agent" size={13} className="mt-0.5 flex-none text-subtle" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13 text-fg">/{skill.name}</span>
              <span className="line-clamp-2 block text-11 text-subtle">
                {skill.description}
              </span>
            </span>
          </button>
        ))}
    </div>
  );
}
