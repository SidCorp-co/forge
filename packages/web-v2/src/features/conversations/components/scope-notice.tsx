"use client";

// What a room is about, said where a person can see it, and said as derived.
//
// ISS-1011: a room spanning two projects is a standing condition — it describes
// something still true — so this collapses and does not dismiss. There is no
// close control on it and there is no project picker anywhere near it: the only
// way to change what a room is about is to change which agents are in it.

import { useState } from "react";
import { Icon } from "@/design";
import { composerRefusal, scopeDerivation } from "../membership";
import type { ConversationMembership } from "../types";

export function ScopeNotice({
  room,
}: {
  room: Pick<ConversationMembership, "scopeProjects">;
}) {
  const [open, setOpen] = useState(true);
  const refusal = composerRefusal(room);
  if (room.scopeProjects.length === 0) return null;

  const spans = room.scopeProjects.length > 1;
  // cm:guard a one-project room shows the derivation as a quiet line and a multi-project room shows the standing condition, and neither of them is dismissible: what a room is about is a fact about the room, and a notice a person can make vanish is a fact the next reader will not have (ISS-1011 criteria 30, 32).
  return (
    <div
      data-testid="scope-notice"
      className={`flex-none border-b px-4 py-2 ${
        spans ? "border-line bg-[color:var(--accent-tint)]" : "border-line-subtle bg-surface"
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <Icon
          name="chevronRight"
          size={13}
          className="flex-none text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-caption truncate text-muted">
          {spans
            ? `About ${room.scopeProjects.length} projects: ${room.scopeProjects
                .map((p) => p.name)
                .join(", ")}`
            : `About ${room.scopeProjects[0]?.name}`}
        </span>
      </button>
      {open && (
        <div className="forge-fade mt-1.5 pl-[21px]">
          <p className="fg-caption text-subtle">{scopeDerivation(room)}</p>
          {refusal && (
            <p className="fg-caption mt-1 text-muted" data-testid="scope-notice-refusal">
              {refusal.reason} {refusal.wayOut}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
