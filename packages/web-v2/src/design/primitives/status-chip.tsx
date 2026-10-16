import { BLOCKED_TONE, STATUS_META, type StatusKey, TONE_META } from "@/design/status";
import { Icon, type IconName } from "@/design/icons/icon";

export type StatusDomain = "issue" | "session";

export interface StatusChipProps {
  status: StatusKey;
  /** When running, append the step the session is on, e.g. `running · implement`, after `label` where one is given. */
  stage?: string;
  size?: "sm" | "md";
  /** Status vocabulary this chip belongs to. Defaults to `issue`. */
  domain?: StatusDomain;
  label?: string;
}

/** Execution-vocabulary overrides for the `session` domain so an agent run reads
 *  as "Completed / Idle" rather than the issue-lifecycle "Done / Paused". Keys not
 *  listed fall back to the shared `STATUS_META`. */
const SESSION_LABELS: Partial<Record<StatusKey, string>> = {
  done: "Completed",
  paused: "Idle",
  passed: "Verified",
  waiting: "Waiting for me",
};

/** In the session domain `blocked` is a running session its box reports blocked: it waits on
 *  someone, so it takes the blocked-session tone rather than a parked issue's. */
const SESSION_TONES: Partial<Record<StatusKey, (typeof TONE_META)[keyof typeof TONE_META]>> = {
  blocked: TONE_META[BLOCKED_TONE],
};

/** A session chip's mark says which state it is in, one mark per status, so no two are told apart
 *  by colour alone. */
const SESSION_ICONS: Record<StatusKey, IconName> = {
  running: "agent",
  queued: "clock",
  blocked: "pause",
  waiting: "bell",
  passed: "shield",
  failed: "alert",
  paused: "dot",
  done: "check",
  shipped: "arrowRight",
  archived: "stop",
  review: "search",
  zombie: "quiet",
  swept: "archive",
};

export function StatusChip({ status, stage, size = "md", domain = "issue", label }: StatusChipProps) {
  const base = STATUS_META[status] ?? STATUS_META.queued;
  const tone = domain === "session" ? SESSION_TONES[status] : undefined;
  const m = tone ? { ...base, fg: tone.fg, bg: tone.bg, dot: tone.dot } : base;
  const isRunning = status === "running";
  const isSession = domain === "session";
  const baseLabel = isSession ? (label ?? SESSION_LABELS[status] ?? m.label) : (label ?? m.label);
  const text = stage && isRunning ? `${label ?? "running"} · ${stage}` : baseLabel;
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
          name={SESSION_ICONS[status] ?? SESSION_ICONS.queued}
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
      <span className="max-w-[16ch] truncate" title={text}>
        {text}
      </span>
    </span>
  );
}
