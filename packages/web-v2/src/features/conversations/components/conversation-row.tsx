// ISS-698 — compact conversation-list row shared by desktop (list column) and
// mobile (stacked cards). Replaces the 4-column `<Table>` whose overflow-hidden
// wrapper clipped Project/Status/Updated at the default 360px list width —
// this template fits both 360px and 375px by design, with the project glyph
// carrying the "which project" signal a bare title couldn't.
import { ProjectMark, StatusChip } from "@/design";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { conversationTitle } from "@/features/session/components/conversation-list";
import {
  deriveSessionDisplayStatus,
  isAwaitingReply,
  statusToChip,
  type SessionRow,
} from "@/features/sessions/types";
import { formatRelativeTime } from "@/lib/utils/format";

interface ProjectInfo {
  name: string;
  slug: string;
}

interface ConversationRowProps {
  row: SessionRow;
  project: ProjectInfo | undefined;
  now: number;
  /** Already open as a desktop pane (ISS-689) — this IS the row's single
   *  "open" signal (border + bg-hover), replacing the old MonoTag "Open"
   *  badge so each row carries exactly one status signal (the StatusChip). */
  open?: boolean;
  onOpen: () => void;
}

export function ConversationRow({ row, project, now, open, onOpen }: ConversationRowProps) {
  const waiting = isAwaitingReply(row);
  const display = deriveSessionDisplayStatus(row, now);
  const chipStatus = waiting ? "waiting" : statusToChip(display);
  const glyph = projectGlyph(project?.slug ?? row.projectId);
  const initials = projectInitials(project?.name ?? "?");
  const secondaryLine = row.lastMessagePreview?.trim() || project?.name || "No preview yet";

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={open ? "true" : undefined}
      className={`flex min-h-[44px] w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--link)] ${
        open ? "border-[color:var(--link)] bg-hover" : "border-transparent"
      }`}
    >
      <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={initials} size={22} />

      <div className="min-w-0 flex-1">
        <span className={`fg-body-sm block truncate ${waiting ? "font-semibold text-fg" : "text-fg"}`}>
          {conversationTitle(row)}
        </span>
        <span className="fg-caption block truncate text-subtle">{secondaryLine}</span>
      </div>

      <div className="flex flex-none flex-col items-end gap-0.5">
        <span className="fg-caption whitespace-nowrap font-mono text-subtle">
          {formatRelativeTime(row.updatedAt)}
        </span>
        <StatusChip status={chipStatus} domain="session" size="sm" />
      </div>
    </button>
  );
}
