import type { StageKey } from "@/design/stages";
import type { StatusKey, AvatarHue } from "@/design/status";
import { MonoTag } from "@/design/primitives/mono-tag";
import { Avatar } from "@/design/primitives/avatar";
import { Stat } from "@/design/primitives/stat";
import { StatusChip } from "@/design/primitives/status-chip";
import { PipelineTracker } from "./pipeline-tracker";

/** StatusKey → tracker run-state, so the card's bead reflects the REAL status
 *  (failed/blocked/done/paused…) instead of collapsing everything that isn't
 *  `running` into `queued` (ISS-436 — failed and queued cards looked identical
 *  until opened). */
const TRACKER_STATUS: Record<StatusKey, "running" | "done" | "failed" | "blocked" | "queued" | "review"> = {
  running: "running",
  done: "done",
  passed: "done",
  failed: "failed",
  blocked: "blocked",
  review: "review",
  waiting: "queued",
  paused: "queued",
  queued: "queued",
  zombie: "failed",
  swept: "queued",
};

export interface KanbanCardProps {
  id: string;
  title: string;
  stage: StageKey;
  status: StatusKey;
  /** Exact chip text override — e.g. the issue's TRUE lifecycle label
   *  ("Approved" / "Needs info") instead of the collapsed bucket label. */
  statusLabel?: string;
  /** Chip vocabulary (ISS-360): `issue` lifecycle pill vs `session` execution
   *  chip (used when a live run's status is shown). Defaults to `issue`. */
  statusDomain?: "issue" | "session";
  cost?: string;
  /** When true, render a small amber "hold" glyph — the issue is on manual
   *  hold so the dispatcher won't pick up new jobs (ISS-386). */
  held?: boolean;
  assignee?: { initials: string; hue?: AvatarHue };
  onClick?: () => void;
}

export function KanbanCard({
  id,
  title,
  stage,
  status,
  statusLabel,
  statusDomain = "issue",
  cost,
  held,
  assignee,
  onClick,
}: KanbanCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${id} — ${title}${held ? " (on manual hold)" : ""}`}
      className="flex w-full flex-col gap-2.5 rounded-md border border-line bg-surface p-3 text-left shadow-xs transition-colors duration-[120ms] hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <MonoTag>{id}</MonoTag>
          {held && (
            <span
              className="inline-flex items-center rounded-pill px-1.5 font-semibold"
              style={{ fontSize: 11, lineHeight: "16px", color: "var(--amberw-600)", background: "var(--amberw-50)" }}
              title="On manual hold — dispatcher won't pick up new jobs"
            >
              ⏸ Hold
            </span>
          )}
        </span>
        {assignee && <Avatar initials={assignee.initials} hue={assignee.hue} size={20} />}
      </div>
      <p className="fg-body-sm line-clamp-2 text-fg" style={{ fontWeight: 500 }}>
        {title}
      </p>
      {/* Real status, visible WITHOUT opening the panel (ISS-436). */}
      <div className="flex items-center justify-between gap-2">
        <StatusChip status={status} size="sm" domain={statusDomain} label={statusLabel} />
        {cost && <Stat icon="dollar">{cost}</Stat>}
      </div>
      <PipelineTracker stage={stage} status={TRACKER_STATUS[status] ?? "queued"} variant="compact" />
    </button>
  );
}
