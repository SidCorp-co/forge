import { Fragment } from "react";
import { STAGES, STAGE_INDEX, type StageKey } from "@/design/stages";
import { Icon } from "@/design/icons/icon";

type RunStatus = "running" | "done" | "failed" | "blocked" | "queued" | "review";
type BeadState = "done" | "active" | "error" | "todo";

function stageState(i: number, currentIdx: number, status: RunStatus): BeadState {
  if (i < currentIdx) return "done";
  if (i === currentIdx) {
    if (status === "failed" || status === "blocked") return "error";
    if (status === "done") return "done";
    return "active";
  }
  return "todo";
}

function Bead({ state, size = 26 }: { state: BeadState; size?: number }) {
  const ring = size > 18 ? 5 : 3;
  const styles: Record<BeadState, React.CSSProperties> = {
    done: { background: "var(--green-500)", border: "2px solid var(--green-500)" },
    // ISS-509 — the active bead uses its own --pipeline-active (cobalt) token so
    // it no longer shares the flame --accent with primary buttons / the
    // "In progress" bar; the halo follows in cobalt-100.
    active: { background: "var(--pipeline-active)", border: "2px solid var(--pipeline-active)", boxShadow: `0 0 0 ${ring}px var(--cobalt-100)` },
    error: { background: "var(--red-500)", border: "2px solid var(--red-500)", boxShadow: `0 0 0 ${ring}px var(--red-50)` },
    todo: { background: "var(--bg-surface)", border: "2px solid var(--border-default)" },
  };
  return (
    <span
      className="inline-flex flex-none items-center justify-center"
      style={{ width: size, height: size, borderRadius: 999, ...styles[state] }}
    >
      {state === "done" && <Icon name="check" size={size * 0.5} strokeWidth={3} style={{ color: "#fff" }} />}
      {state === "error" && <Icon name="x" size={size * 0.5} strokeWidth={3} style={{ color: "#fff" }} />}
      {state === "active" && (
        <span className="forge-pulse" style={{ width: size * 0.34, height: size * 0.34, borderRadius: 999, background: "#fff" }} />
      )}
    </span>
  );
}

/** Per-stage override cell (ISS-377). When `cells` is supplied, each bead's
 *  state comes from `cells[key].state` (done/current/pending/error mapped to the
 *  bead vocabulary) instead of being inferred from `stage` + `status`, and the
 *  short `outcomeLabel` renders under the label in the `full` variant. */
export interface PipelineTrackerCell {
  state: "done" | "current" | "pending" | "error";
  outcomeLabel?: string;
}

const CELL_TO_BEAD: Record<PipelineTrackerCell["state"], BeadState> = {
  done: "done",
  current: "active",
  pending: "todo",
  error: "error",
};

export interface PipelineTrackerProps {
  stage: StageKey;
  status?: RunStatus;
  /** full = labeled beads (run header) · compact = beads only (board rows) ·
      mini = "4 / 7" + thin bar (dense lists). */
  variant?: "full" | "compact" | "mini";
  /** ISS-377 — per-stage state + short outcome, when the caller has richer
   *  signal than `stage`/`status` (issue-detail spine). Optional; omitting it
   *  keeps the original inferred-state behavior for every existing call-site. */
  cells?: Partial<Record<StageKey, PipelineTrackerCell>>;
  /** Makes beads interactive: clicking stage `s` calls `onSelect(s)` (used to
   *  focus/expand the matching artifact card). `full` variant only. */
  onSelect?: (stage: StageKey) => void;
  /** Currently-focused stage, highlighted when `onSelect` is set. */
  selected?: StageKey;
}

export function PipelineTracker({
  stage,
  status = "running",
  variant = "full",
  cells,
  onSelect,
  selected,
}: PipelineTrackerProps) {
  const currentIdx = STAGE_INDEX[stage] ?? 0;

  if (variant === "mini") {
    const done = status === "done" ? STAGES.length : currentIdx;
    const pct =
      ((status === "done" ? STAGES.length : currentIdx + (status === "running" ? 0.5 : 0)) / STAGES.length) * 100;
    const isErr = status === "failed" || status === "blocked";
    return (
      <div className="flex items-center gap-[9px]" style={{ minWidth: 116 }}>
        <span className="whitespace-nowrap font-mono text-muted" style={{ fontSize: 12 }}>
          {done} / {STAGES.length}
        </span>
        <div className="relative h-1 flex-1 overflow-hidden rounded-pill bg-[var(--paper-200)]">
          <div
            className="h-full rounded-pill transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              width: `${pct}%`,
              background: isErr ? "var(--red-500)" : status === "done" ? "var(--green-500)" : "var(--pipeline-active)",
            }}
          />
          {/* active run → a cobalt sliver sweeps to signal "in progress, % unknown" */}
          {status === "running" && <span className="forge-indeterminate" style={{ background: "var(--pipeline-active)" }} />}
        </div>
      </div>
    );
  }

  const size = variant === "compact" ? 16 : 26;
  const interactive = variant === "full" && !!onSelect;
  // ISS-515 — on narrow viewports the labeled `full` row (7 mono labels) is
  // wider than the content box and was clipping the final stage. Wrap the row
  // in a bounded horizontal-scroll container and let the inner row grow to its
  // content width (`w-max`) while never shrinking below the container
  // (`min-w-full`). At ≥sm the row already fits, so `min-w-full` wins and the
  // connectors stretch full-width exactly as before (no desktop regression);
  // on narrow viewports it scrolls inside the card instead of overflowing the
  // page. The vertical padding keeps the active-bead halo + focus ring from
  // being clipped by `overflow`.
  return (
    <div className="w-full overflow-x-auto py-1">
      <div className="flex w-max min-w-full items-start">
        {STAGES.map((s, i) => {
        const cell = cells?.[s.key];
        const st: BeadState = cell ? CELL_TO_BEAD[cell.state] : stageState(i, currentIdx, status);
        const last = i === STAGES.length - 1;
        const isSelected = selected === s.key;
        const label = (
          <span
            className="font-mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.02em",
              fontWeight: st === "active" || isSelected ? 700 : 500,
              color:
                st === "active"
                  ? "var(--cobalt-700)"
                  : st === "done"
                    ? "var(--green-600)"
                    : st === "error"
                      ? "var(--red-600)"
                      : "var(--fg-subtle)",
            }}
          >
            {s.label}
          </span>
        );
        const column = (
          <div className="flex flex-col items-center" style={{ gap: variant === "compact" ? 0 : 8 }}>
            <Bead state={st} size={size} />
            {variant === "full" && label}
            {variant === "full" && cell?.outcomeLabel && (
              <span
                className="max-w-[88px] truncate text-center"
                style={{ fontSize: 10, lineHeight: 1.25, color: "var(--fg-subtle)" }}
                title={cell.outcomeLabel}
              >
                {cell.outcomeLabel}
              </span>
            )}
          </div>
        );
        return (
          <Fragment key={s.key}>
            {interactive ? (
              <button
                type="button"
                onClick={() => onSelect?.(s.key)}
                aria-label={`${s.label}: ${cell?.outcomeLabel ?? cell?.state ?? "stage"}`}
                aria-pressed={isSelected}
                className="flex flex-none rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-[var(--paper-100)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                style={isSelected ? { background: "var(--paper-100)" } : undefined}
              >
                {column}
              </button>
            ) : (
              column
            )}
            {!last && (
              <div
                className="h-0.5 flex-1 transition-[background] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{
                  background: st === "done" ? "var(--green-500)" : "var(--border-default)",
                  margin: variant === "compact" ? "7px 2px 0" : "12px 3px 0",
                }}
              />
            )}
          </Fragment>
        );
        })}
      </div>
    </div>
  );
}
