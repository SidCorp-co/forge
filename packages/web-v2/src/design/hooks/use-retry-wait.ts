"use client";

import { useEffect, useState } from "react";
import { askedWaitWords, retryAt, retryWaitWords } from "@/lib/utils/retry-rule";

/** The wait before a failed read's Retry, counted down each second; null where there is none or once it is over. */
export function useRetryWait(error: unknown): string | null {
  const at = retryAt(error);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= at) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [at]);
  return retryWaitWords(error, now);
}

/** Whether the server's wait before a failed read's Retry still runs: re-rendering once, as it ends, rather than each
 *  second, for a part that says where the wait is counted without counting it (ISS-1229 r52, judge-162). */
export function useRetryWaiting(error: unknown): boolean {
  const at = retryAt(error);
  const [, setEnded] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const left = at - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => setEnded((n) => n + 1), left + 5);
    return () => clearTimeout(id);
  }, [at]);
  return at !== null && Date.now() < at;
}

/**
 * What a live region says of a failed read's wait: what the server asked for once as it starts, and that Retry is back
 * once as it ends, never each second it counts (ISS-1229 r52, judge-162: the rail's status re-announced every tick).
 * Empty until the first effect, so a region mounted with the wait running still announces it.
 */
export function useWaitAnnouncement(error: unknown): string | null {
  const waiting = useRetryWaiting(error);
  const asked = askedWaitWords(error);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (waiting) setSaid(asked);
    else setSaid((was) => (was === null ? null : WAIT_OVER));
  }, [waiting, asked]);
  return said;
}

/** What the live region says as a wait ends. */
export const WAIT_OVER = "You can retry now.";
