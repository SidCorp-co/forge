"use client";

import { useEffect, useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";

function fmt(ms: number, t: Copy): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return t("common.elapsed.hours", { h, m: String(m % 60).padStart(2, "0") });
  if (m > 0) return t("common.elapsed.minutes", { m, s: String(s % 60).padStart(2, "0") });
  return t("common.age.seconds", { n: s });
}

/** A live-ticking elapsed-time label (run / session duration) — counts up
    every second client-side, no refetch. Pass `startMs` (epoch ms); set
    `running=false` to freeze at the final value. */
export function useElapsed(startMs?: number, running = true): string {
  const [now, setNow] = useState(() => startMs ?? 0);
  const t = useCopy();

  useEffect(() => {
    if (!startMs) return;
    setNow(Date.now());
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startMs, running]);

  if (!startMs) return "—";
  return fmt(now - startMs, t);
}
