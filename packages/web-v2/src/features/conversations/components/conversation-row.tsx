// One row of the conversation list — the template that fits both a 360px list
// column and a 375px phone, with the project glyph carrying the "which project"
// signal a bare title cannot (ISS-698).
//
// It reads a conversation now rather than a session (ISS-1004 step 5). What went
// with the session row: the status chip and the awaiting-reply weight, both of
// which described a RUN's lifecycle. A conversation has no status — it has what
// was last said in it and when.

import { ProjectMark } from "@/design";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatRelativeTime } from "@/lib/utils/format";
import type { ListedConversation } from "../hooks";
import { conversationTitle } from "../types";

interface ProjectInfo {
  name: string;
  slug: string;
}

export function ConversationRow({
  row,
  project,
  open,
  onOpen,
}: {
  row: ListedConversation;
  project: ProjectInfo | undefined;
  /** Already the open conversation — the row's single "open" signal. */
  open?: boolean;
  onOpen: () => void;
}) {
  const glyph = projectGlyph(project?.slug ?? row.projectId);
  const initials = projectInitials(project?.name ?? "?");

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
        <span className="fg-body-sm block truncate text-fg">{conversationTitle(row)}</span>
        <span className="fg-caption block truncate text-subtle">
          {project?.name ?? "Unknown project"}
        </span>
      </div>
      <span className="fg-caption flex-none whitespace-nowrap font-mono text-subtle">
        {formatRelativeTime(row.updatedAt)}
      </span>
    </button>
  );
}
