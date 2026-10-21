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

/**
 * The projects a listed room is about, by name, from its own scope: the same names whichever project's
 * list the row came through (ISS-1229 r33, judge-92). A project with no name to hand is left out.
 */
export function projectsOfRow(
  row: Pick<ListedConversation, "scope" | "projectId">,
  nameOf: (projectId: string) => ProjectInfo | undefined,
): ProjectInfo[] {
  const ids = row.scope.length > 0 ? row.scope : [row.projectId];
  return ids
    .flatMap((id) => {
      const named = nameOf(id);
      return named ? [named] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const namesOf = (projects: readonly ProjectInfo[]): string => {
  const names = projects.map((p) => p.name);
  if (names.length === 0) return "Unknown project";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

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
  projects,
  open,
  onOpen,
  onRename,
  onArchive,
  onDelete,
}: {
  row: ListedConversation;
  /** Every project the room is about, as `projectsOfRow` reads them. */
  projects: readonly ProjectInfo[];
  /** Already the open conversation — the row's single "open" signal. */
  open?: boolean;
  onOpen: () => void;
} & ConversationRowActions) {
  const project = projects[0];
  const glyph = projectGlyph(project?.slug ?? row.projectId);
  const initials = projectInitials(project?.name ?? "?");
  const about = namesOf(projects);
  const archived = row.archivedAt !== null;

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

  return (
    <div
      className={`group relative flex min-h-[44px] w-full items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors focus-within:border-[color:var(--link)] hover:bg-hover ${
        open ? "border-[color:var(--link)] bg-hover" : "border-transparent"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={open ? "true" : undefined}
        aria-label={`Open ${conversationTitle(row)} in ${projects.length > 0 ? about : "an unknown project"}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)]"
      >
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={initials} size={22} />
        <div className="min-w-0 flex-1">
          <span className="fg-body-sm block truncate text-fg">{conversationTitle(row)}</span>
          <span className="fg-caption block truncate text-subtle">{about}</span>
        </div>
      </button>

      {/* Over the row's end, so hidden controls hold no width from the title (ISS-1229 r25). */}
      <div
        className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-hover opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        data-testid="conversation-row-actions"
      >
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
