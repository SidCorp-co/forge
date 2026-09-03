import { STATUS_META, type StatusKey } from "@/design/status";
import { Icon } from "@/design/icons/icon";

/** Two status vocabularies share this chip but must never be confused (ISS-360):
 *  - `issue`   → the lifecycle of a work item (Open → … → Released). Rounded
 *                pill, sans label, a leading status dot.
 *  - `session` → the execution state of an agent run / job. Squared chip, mono
 *                label, a leading agent glyph, and the run vocabulary
 *                (Running / Queued / Completed / Failed / Stalled / Idle). */
export type StatusDomain = "issue" | "session";

export interface StatusChipProps {
  status: StatusKey;
  /** When running, append the active pipeline stage, e.g. `running · code`. */
  stage?: string;
  size?: "sm" | "md";
  /** Status vocabulary this chip belongs to. Defaults to `issue`. */
  domain?: StatusDomain;
  /** Override the chip text with an exact label — the issue's TRUE lifecycle
   *  status ("Approved" / "Confirmed" / …) in the `issue` domain, or the gate
   *  holding a queued step ("No runner online") in the `session` one — while
   *  keeping the bucket colour + dot for at-a-glance grouping. Overridden only
   *  by the live `running · stage` band. ISS-366 D2, ISS-903. */
  // cm:guard a session-domain label must be RUN vocabulary — a gate, a step, an execution state — and never an issue lifecycle status: mixing the two is what ISS-366 D2 separated the domains to stop, and honouring `label` here is only sound while that holds
  label?: string;
}

/** Execution-vocabulary overrides for the `session` domain so an agent run reads
 *  as "Completed / Stalled / Idle" rather than the issue-lifecycle "Done /
 *  Zombie / Paused". Keys not listed fall back to the shared `STATUS_META`. */
const SESSION_LABELS: Partial<Record<StatusKey, string>> = {
  done: "Completed",
  zombie: "Stalled",
  paused: "Idle",
  passed: "Verified",
  // cm:guard "Waiting for me" is the INTERACTIVE-CHAT default (ISS-664) and is a lie for a machine gate — a caller that knows why the run is waiting passes `label`, which now wins over this entry; before ISS-903 it was dropped, so a `retry_cooldown` step whose own copy reads "no action" told the reader to act
  waiting: "Waiting for me",
};

export function StatusChip({ status, stage, size = "md", domain = "issue", label }: StatusChipProps) {
  const m = STATUS_META[status] ?? STATUS_META.queued;
  const isRunning = status === "running";
  const isSession = domain === "session";
  const baseLabel = isSession ? (label ?? SESSION_LABELS[status] ?? m.label) : (label ?? m.label);
  const text = stage && isRunning ? `running · ${stage}` : baseLabel;
  // Session chips always read in mono (execution telemetry); issue chips use the
  // sans label unless they're showing the live `running · stage` band.
  const mono = isSession || (stage && isRunning);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap font-semibold ${
        isSession ? "rounded-md" : "rounded-pill"
      }`}
      style={{
        color: m.fg,
        background: m.bg,
        padding: size === "sm" ? "3px 8px" : "4px 10px",
        fontSize: size === "sm" ? 11.5 : 12.5,
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        border: isSession ? `1px solid ${m.dot}` : "none",
      }}
    >
      {isSession ? (
        <Icon
          name="agent"
          size={size === "sm" ? 11 : 12}
          className={isRunning ? "forge-pulse" : ""}
          style={{ color: m.dot }}
        />
      ) : (
        <span
          className={isRunning ? "forge-pulse" : ""}
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: m.dot,
            boxShadow: isRunning ? `0 0 0 3px ${m.bg}` : "none",
          }}
        />
      )}
      {text}
    </span>
  );
}
