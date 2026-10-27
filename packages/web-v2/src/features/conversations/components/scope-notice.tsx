"use client";

// What a room is about, said where a person can see it, and said as derived.
//
// ISS-1011: a room spanning two projects is a standing condition — it describes
// something still true — so this collapses and does not dismiss. There is no
// close control on it and there is no project picker anywhere near it: the only
// way to change what a room is about is to change which agents are in it.

import { useRef, useState } from "react";
import { Icon } from "@/design";
import { answeringAgents, composerRefusal, unansweringAgentLines, whereWhyIsSaid } from "../membership";
import type { ConversationMembership } from "../types";

export function ScopeNotice({
  room,
  folded = false,
  canPost = true,
}: {
  room: Partial<Pick<ConversationMembership, "scopeProjects" | "participants" | "canChangeMembership">>;
  /** Whether the reader may post here: one who may not is offered no way out (ISS-1229 r35). */
  canPost?: boolean;
  /** Shown folded to its one line, whatever the reader left it at: the room's message box has focus
   *  on a phone, and the thread needs the height (ISS-1229 r32, judge-90). */
  folded?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const shown = open && !folded;
  // A press on the folded line takes focus from the box, which unfolds it before the click lands; the
  // click then means "open", not "toggle what just unfolded".
  const foldedAtPress = useRef(false);
  const refusal = composerRefusal(room, { canPost });
  const scopeProjects = room.scopeProjects ?? [];
  if (scopeProjects.length === 0) return null;

  const spans = scopeProjects.length > 1;
  return (
    <div
      data-testid="scope-notice"
      className={`flex-none border-b px-4 py-2 ${
        spans ? "border-line bg-[color:var(--accent-tint)]" : "border-line-subtle bg-surface"
      }`}
    >
      <button
        type="button"
        aria-expanded={shown}
        onPointerDown={() => {
          foldedAtPress.current = folded;
        }}
        onClick={() => {
          setOpen((o) => (foldedAtPress.current ? true : !o));
          foldedAtPress.current = false;
        }}
        className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <Icon
          name="chevronRight"
          size={13}
          className="flex-none text-subtle transition-transform duration-[150ms]"
          style={{ transform: shown ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-caption truncate text-muted">
          {spans
            ? `About ${scopeProjects.length} projects: ${scopeProjects.map((p) => p.name).join(", ")}`
            : `About ${scopeProjects[0]?.name}`}
        </span>
      </button>
      {shown && (
        <div className="forge-fade mt-1.5 pl-[21px]">
          <p className="fg-caption text-subtle">{answeringAgents(room)}</p>
          {unansweringAgentLines(room, whereWhyIsSaid(room, canPost) === "box").map((line) => (
            <p key={line} className="fg-caption mt-1 text-muted" data-testid="scope-notice-unanswering">
              {line}
            </p>
          ))}
          {refusal && (
            <p className="fg-caption mt-1 text-muted" data-testid="scope-notice-refusal">
              {refusal.reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
