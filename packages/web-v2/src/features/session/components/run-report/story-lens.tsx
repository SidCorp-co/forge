"use client";

// The Story lens — every tool call folded into at most five expandable rows.
//
// This is the default view because a pipeline transcript is not read: a code
// step runs 180 calls at p90 and 1,055 at the tail, and scrolling that to learn
// "it edited 4 files and one test failed" is the problem this page exists to
// fix. The transcript lens is still one click away for the reader who needs the
// row at 01:00:41.
//
// The first row opens on load — errors when there were any, since the order puts
// them first. A run that failed shows why without a click; a run that passed
// shows what it ran.
//
// Above the rows sits the agent's conclusion in its own words. Folding tool
// calls is the point of this lens; folding away the agent's voice was not, and
// for one release it did exactly that.

import { useState } from "react";
import { Icon, type IconName } from "@/design";
import type { ActivityGroup, ActivityKind, Narration } from "../../run-report";

const GLYPH: Record<ActivityKind, { icon: IconName; color: string }> = {
  errors: { icon: "alert", color: "var(--red-600)" },
  ran: { icon: "play", color: "var(--fg-muted)" },
  edited: { icon: "branch", color: "var(--flame-600)" },
  forge: { icon: "agent", color: "var(--cobalt-500)" },
  explored: { icon: "search", color: "var(--fg-subtle)" },
};

const TONE_COLOR = {
  ok: "var(--green-600)",
  bad: "var(--red-600)",
  muted: "var(--fg-subtle)",
} as const;

function GroupRow({ group, defaultOpen }: { group: ActivityGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const glyph = GLYPH[group.kind];
  const hidden = group.total - group.children.length;
  return (
    <li className="border-line-subtle border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="flex-none text-subtle" />
        <Icon name={glyph.icon} size={14} className="flex-none" style={{ color: glyph.color }} />
        <span className="fg-body-sm truncate">{group.headline}</span>
        {group.meta && <span className="fg-caption ml-auto flex-none">{group.meta}</span>}
      </button>
      {open && (
        <ul className="space-y-1 px-3 pb-2.5 pl-10">
          {group.children.map((child) => (
            <li key={child.id} className="flex items-baseline gap-2">
              <span className="fg-body-sm min-w-0 flex-1 truncate">{child.label}</span>
              <span
                className="fg-caption flex-none font-mono"
                style={{ color: TONE_COLOR[child.outcome.tone] }}
              >
                {child.outcome.text}
              </span>
            </li>
          ))}
          {hidden > 0 && <li className="fg-caption">+ {hidden} more</li>}
        </ul>
      )}
    </li>
  );
}

export function StoryLens({
  groups,
  thinkingPauses,
  narration,
  onOpenTranscript,
}: {
  groups: ActivityGroup[];
  thinkingPauses: number;
  narration: Narration;
  onOpenTranscript?: () => void;
}) {
  return (
    <div>
      {narration.closing && (
        <div className="border-line-subtle border-b px-3 py-2.5">
          <p className="fg-caption mb-1">What the agent concluded</p>
          <p className="fg-body-sm whitespace-pre-wrap">{narration.closing}</p>
          {narration.count > 1 && onOpenTranscript && (
            <button
              type="button"
              onClick={onOpenTranscript}
              className="fg-caption mt-1.5 underline underline-offset-2"
            >
              {narration.count} notes written during the run →
            </button>
          )}
        </div>
      )}
      <ul>
        {groups.map((group, i) => (
          <GroupRow key={group.kind} group={group} defaultOpen={i === 0} />
        ))}
      </ul>
      {thinkingPauses > 0 && (
        <p className="fg-caption border-line-subtle border-t px-3 py-2">
          ◇ <b>{thinkingPauses}</b> thinking pauses — the CLI emits the block but not its text, so
          this is density, not something to expand
        </p>
      )}
    </div>
  );
}
