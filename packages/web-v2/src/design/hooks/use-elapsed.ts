"use client";

import { useEffect, useState } from "react";

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** A live-ticking elapsed-time label (run / session duration) — counts up
    every second client-side, no refetch. Pass `startMs` (epoch ms); set
    `running=false` to freeze at the final value. */
export function useElapsed(startMs?: number, running = true): string {
  const [now, setNow] = useState(() => startMs ?? 0);

  useEffect(() => {
    if (!startMs) return;
    setNow(Date.now());
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startMs, running]);

  if (!startMs) return "—";
  return fmt(now - startMs);
}
