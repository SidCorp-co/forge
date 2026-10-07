"use client";

import { useCopy } from "@/lib/i18n/interface-language";

type State = "live" | "connecting" | "offline";

const META: Record<State, { color: string; pulse: boolean }> = {
  live: { color: "var(--green-500)", pulse: true },
  connecting: { color: "var(--amberw-500)", pulse: true },
  offline: { color: "var(--ink-400)", pulse: false },
};

export interface LiveDotProps {
  state: State;
  withLabel?: boolean;
}

/** Real-time connection indicator (WebSocket status). */
export function LiveDot({ state, withLabel = false }: LiveDotProps) {
  const m = META[state];
  const t = useCopy();
  return (
    <span className="inline-flex items-center gap-1.5" style={{ fontSize: "var(--text-12)", color: "var(--fg-muted)" }}>
      <span
        className={m.pulse ? "forge-pulse" : ""}
        style={{ width: 7, height: 7, borderRadius: 999, background: m.color }}
      />
      {withLabel && t(`common.liveDot.${state}`)}
    </span>
  );
}
