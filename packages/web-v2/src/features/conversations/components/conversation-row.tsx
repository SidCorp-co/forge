"use client";

// One row of the conversation list — the template that fits both a 360px list
// column and a 375px phone, with the project glyph carrying the "which project"
// signal a bare title cannot (ISS-698).
//
// It reads a conversation now rather than a session (ISS-1004 step 5). What went
// with the session row: the status chip and the awaiting-reply weight, both of
// which described a RUN's lifecycle. A conversation has no status — it has what
// was last said in it and when.
//
// Since ISS-1028 it also carries what a person does TO a room: rename, archive
// and delete. They live here rather than on each list because the dock's list
// and the full-page sidebar both render this row, and two copies of a
// destructive control is two places for them to disagree about what a press
// means.

import { useState } from "react";
import { IconButton, Input, ProjectMark } from "@/design";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatRelativeTime } from "@/lib/utils/format";
import type { ListedConversation } from "../hooks";
import { conversationTitle } from "../types";

interface ProjectInfo {
  name: string;
  slug: string;
}

export interface ConversationRowActions {
  /** Commit a new title. Absent = the row shows no rename control. */
  onRename?: (title: string) => void;
  /** File it away, or bring it back — the row reads which from `row.archivedAt`. */
  onArchive?: (archived: boolean) => void;
  /** Ask to delete it. The caller owns the confirmation, not this row. */
  onDelete?: () => void;
}

export function ConversationRow({
  row,
  project,
  open,
  onOpen,
  onRename,
  onArchive,
  onDelete,
}: {
  row: ListedConversation;
  project: ProjectInfo | undefined;
  /** Already the open conversation — the row's single "open" signal. */
  open?: boolean;
  onOpen: () => void;
} & ConversationRowActions) {
  const glyph = projectGlyph(project?.slug ?? row.projectId);
  const initials = projectInitials(project?.name ?? "?");
  const archived = row.archivedAt !== null;

  // cm:guard the editor is a state of THIS row and the draft is seeded when it opens rather than on
  // every render: a render-time seed would overwrite what somebody is typing the moment a websocket
  // refetch landed a new `updatedAt` on the row, which is exactly while they are typing into it.
  const [editing, setEditing] = useState<string | null>(null);
  const draft = editing ?? "";
  const setDraft = (v: string) => setEditing(v);

  const commit = () => {
    const next = draft.trim();
    setEditing(null);
    if (next.length > 0 && next !== conversationTitle(row)) onRename?.(next);
  };

  if (editing !== null) {
    return (
      <div className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-[color:var(--link)] px-2 py-1.5">
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={initials} size={22} />
        {/* cm:why the field takes focus on mount because the editor only ever opens from a
            deliberate press on this row's rename control — focus belongs where that press asked */}
        <Input
          autoFocus
          value={draft}
          aria-label="Conversation name"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(null);
          }}
          onBlur={commit}
          className="min-w-0 flex-1"
        />
      </div>
    );
  }

  // cm:guard the actions are SIBLINGS of the open button and never nested inside it: a button
  // inside a button is invalid HTML, React hoists it out of the parent, and the press that lands
  // on the inner one opens the room as well as deleting it.
  // cm:guard `focus-within` sits beside `group-hover` on every action, because a control revealed
  // by hover alone is a control a keyboard cannot reach — it is focusable, receives the tab, and
  // stays invisible while it holds focus.
  return (
    <div
      className={`group flex min-h-[44px] w-full items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors focus-within:border-[color:var(--link)] hover:bg-hover ${
        open ? "border-[color:var(--link)] bg-hover" : "border-transparent"
      }`}
    >
      {/* cm:guard the open target carries an explicit label rather than leaving its name to its own
          text: `ProjectMark` renders the project's initials as live text, so the computed name was
          "ALRelease planAlpha" — a room announced to a screen reader by two letters nobody says out
          loud, and a name no test could match without encoding that accident. */}
      <button
        type="button"
        onClick={onOpen}
        aria-current={open ? "true" : undefined}
        aria-label={`Open ${conversationTitle(row)} in ${project?.name ?? "an unknown project"}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)]"
      >
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={initials} size={22} />
        <div className="min-w-0 flex-1">
          <span className="fg-body-sm block truncate text-fg">{conversationTitle(row)}</span>
          <span className="fg-caption block truncate text-subtle">
            {project?.name ?? "Unknown project"}
          </span>
        </div>
      </button>

      <div className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {onRename && (
          <IconButton
            icon="rename"
            size="sm"
            aria-label={`Rename ${conversationTitle(row)}`}
            onClick={() => setEditing(conversationTitle(row))}
          />
        )}
        {onArchive && (
          <IconButton
            icon="archive"
            size="sm"
            aria-label={`${archived ? "Unarchive" : "Archive"} ${conversationTitle(row)}`}
            onClick={() => onArchive(!archived)}
          />
        )}
        {onDelete && (
          <IconButton
            icon="trash"
            size="sm"
            aria-label={`Delete ${conversationTitle(row)}`}
            onClick={onDelete}
          />
        )}
      </div>

      <span className="fg-caption flex-none whitespace-nowrap font-mono text-subtle group-focus-within:hidden group-hover:hidden">
        {formatRelativeTime(row.updatedAt)}
      </span>
    </div>
  );
}
