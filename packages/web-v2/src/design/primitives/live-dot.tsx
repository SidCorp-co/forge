type State = "live" | "connecting" | "offline";

const META: Record<State, { color: string; label: string; pulse: boolean }> = {
  live: { color: "var(--green-500)", label: "Live", pulse: true },
  connecting: { color: "var(--amberw-500)", label: "Reconnecting…", pulse: true },
  offline: { color: "var(--ink-400)", label: "Offline", pulse: false },
};

export interface LiveDotProps {
  state: State;
  withLabel?: boolean;
}

/** Real-time connection indicator (WebSocket status). */
export function LiveDot({ state, withLabel = false }: LiveDotProps) {
  const m = META[state];
  return (
    <span className="inline-flex items-center gap-1.5" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
      <span
        className={m.pulse ? "forge-pulse" : ""}
        style={{ width: 7, height: 7, borderRadius: 999, background: m.color }}
      />
      {withLabel && m.label}
    </span>
  );
}
