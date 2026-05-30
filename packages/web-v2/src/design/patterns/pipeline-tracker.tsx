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
    active: { background: "var(--accent)", border: "2px solid var(--accent)", boxShadow: `0 0 0 ${ring}px var(--flame-100)` },
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

export interface PipelineTrackerProps {
  stage: StageKey;
  status?: RunStatus;
  /** full = labeled beads (run header) · compact = beads only (board rows) ·
      mini = "4 / 7" + thin bar (dense lists). */
  variant?: "full" | "compact" | "mini";
}

export function PipelineTracker({ stage, status = "running", variant = "full" }: PipelineTrackerProps) {
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
        <div className="h-1 flex-1 overflow-hidden rounded-pill bg-[var(--paper-200)]">
          <div
            className="h-full rounded-pill"
            style={{
              width: `${pct}%`,
              background: isErr ? "var(--red-500)" : status === "done" ? "var(--green-500)" : "var(--accent)",
            }}
          />
        </div>
      </div>
    );
  }

  const size = variant === "compact" ? 16 : 26;
  return (
    <div className="flex w-full items-start">
      {STAGES.map((s, i) => {
        const st = stageState(i, currentIdx, status);
        const last = i === STAGES.length - 1;
        return (
          <Fragment key={s.key}>
            <div className="flex flex-col items-center" style={{ gap: variant === "compact" ? 0 : 8 }}>
              <Bead state={st} size={size} />
              {variant === "full" && (
                <span
                  className="font-mono"
                  style={{
                    fontSize: 11,
                    letterSpacing: "0.02em",
                    fontWeight: st === "active" ? 700 : 500,
                    color:
                      st === "active"
                        ? "var(--accent-text)"
                        : st === "done"
                          ? "var(--green-600)"
                          : st === "error"
                            ? "var(--red-600)"
                            : "var(--fg-subtle)",
                  }}
                >
                  {s.label}
                </span>
              )}
            </div>
            {!last && (
              <div
                className="h-0.5 flex-1"
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
  );
}
