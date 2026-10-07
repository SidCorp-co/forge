"use client";

// One row of the conversation list, fitting both a 360px list column and a 375px phone; the project
// glyph carries the "which project" signal a bare title cannot (ISS-698). Rename, archive and delete
// live here rather than on each list, because the dock's list and the full-page sidebar both render
// this row and two copies of a destructive control can disagree about what a press means (ISS-1028).

import { useState } from "react";
import { IconButton, Input, ProjectMark, StatusBadge } from "@/design";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
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
  onPin?: (pinned: boolean) => void;
}

export function ConversationRow({
  row,
  project,
  open,
  onOpen,
  onRename,
  onArchive,
  onDelete,
  onPin,
}: {
  row: ListedConversation;
  project: ProjectInfo | undefined;
  /** Already the open conversation — the row's single "open" signal. */
  open?: boolean;
  onOpen: () => void;
} & ConversationRowActions) {
  const t = useCopy();
  const time = useTimeFormat();
  const glyph = projectGlyph(project?.slug ?? row.projectId);
  const initials = projectInitials(project?.name ?? "?");

  const title = conversationTitle(row, null, t("shell.dock.newConversation"));
  const archived = row.archivedAt !== null;
  const [editing, setEditing] = useState(false);
  const mark = <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={initials} size={22} />;

  if (editing) {
    return (
      <RenameRow
        mark={mark}
        title={title}
        onDone={(next) => {
          setEditing(false);
          if (next) onRename?.(next);
        }}
      />
    );
  }

  return (
    <div
      className={`group flex min-h-[44px] w-full items-center gap-2 border-b border-line-subtle px-3 py-2 transition-colors hover:bg-hover ${
        open ? "bg-active" : ""
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={open ? "true" : undefined}
        aria-label={t("shell.row.open", { title, project: project?.name ?? t("shell.row.unknownProjectLower") })}
        title={t("shell.row.scope", { scope: row.ecosystemId ? t("nav.ecosystem") : t("common.nav.project"), project: project?.name ?? t("shell.row.unknownProject") })}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)]"
      >
        {mark}
        <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{title}</span>
        {row.threadStatus && <StatusBadge family="thread" value={row.threadStatus} />}
      </button>

      {/* Out of the layout until wanted: an invisible group still takes its width, and four
          actions in a 207px row left the title none. */}
      <div className="hidden flex-none items-center gap-0.5 group-focus-within:flex group-hover:flex">
        {onPin && (
          <IconButton icon="pin" size="sm" aria-pressed={row.pinned === true} aria-label={t(row.pinned ? "shell.row.unpin" : "shell.row.pin", { title })} onClick={() => onPin(!row.pinned)} />
        )}
        {onRename && <IconButton icon="rename" size="sm" aria-label={t("shell.row.rename", { title })} onClick={() => setEditing(true)} />}
        {onArchive && (
          <IconButton icon="archive" size="sm" aria-label={t(archived ? "shell.row.unarchive" : "shell.row.archive", { title })} onClick={() => onArchive(!archived)} />
        )}
        {onDelete && <IconButton icon="trash" size="sm" aria-label={t("shell.row.delete", { title })} onClick={onDelete} />}
      </div>

      <span className="fg-caption flex-none whitespace-nowrap font-mono text-subtle group-focus-within:hidden group-hover:hidden">
        {time.relative(row.updatedAt)}
      </span>
    </div>
  );
}

/** The row as a name field; `onDone` gets the new title, or null when nothing changed. */
function RenameRow({ mark, title, onDone }: { mark: React.ReactNode; title: string; onDone: (next: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const t = useCopy();
  const commit = () => {
    const next = draft.trim();
    onDone(next.length > 0 && next !== title ? next : null);
  };
  return (
    <div className="flex min-h-[44px] w-full items-center gap-2 border-b border-line-subtle bg-surface px-3 py-1.5">
      {mark}
      <Input
        autoFocus
        value={draft}
        aria-label={t("shell.row.name")}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onDone(null);
        }}
        onBlur={commit}
        className="min-w-0 flex-1"
      />
    </div>
  );
}
