import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { AvatarHue } from "@/design/status";
import { MonoTag } from "@/design/primitives/mono-tag";
import { Avatar } from "@/design/primitives/avatar";
import { Stat } from "@/design/primitives/stat";
import { ToneBadge } from "@/design/primitives/enum-badge";

export interface KanbanCardProps {
  id: string;
  title: string;
  /** The item's state, a StatusBadge, visible without opening it (ISS-436). */
  badge: ReactNode;
  cost?: string;
  /** On manual hold: the dispatcher picks up no new job (ISS-386). */
  held?: boolean;
  waitingReason?: string;
  /** A line under the title, e.g. when a row nothing holds last checked in. */
  note?: string;
  assignee?: { initials: string; hue?: AvatarHue };
  onClick?: () => void;
}

/** One item on a board column: key, title, state. A hairline tile, flat, no shadow. */
export function KanbanCard({ id, title, badge, cost, held, waitingReason, note, assignee, onClick }: KanbanCardProps) {
  const t = useCopy();
  const label = [
    t("common.kanban.open", { id, title }),
    held ? t("common.kanban.held") : null,
    waitingReason ? t("common.kanban.waiting", { reason: waitingReason }) : null,
    note ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex w-full flex-col gap-2 border border-line-subtle bg-surface p-3 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <MonoTag>{id}</MonoTag>
          {held && <ToneBadge tone="you" glyph="⏸" label={t("common.kanban.hold")} title={t("common.kanban.held")} />}
        </span>
        {assignee && <Avatar initials={assignee.initials} hue={assignee.hue} size={20} />}
      </div>
      <p className="line-clamp-2 text-13 font-medium text-fg">{title}</p>
      {note && <p className="fg-caption text-muted">{note}</p>}
      <div className="flex items-center justify-between gap-2">
        <span title={waitingReason}>{badge}</span>
        {cost && <Stat icon="dollar">{cost}</Stat>}
      </div>
    </button>
  );
}
