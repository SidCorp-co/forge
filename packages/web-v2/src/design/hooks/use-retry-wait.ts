"use client";

import { useEffect, useState } from "react";
import { showWait } from "@/design/hooks/wait-announcer";
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

/** Whether a failed read's wait still runs, re-rendering once as it ends rather than each second (ISS-1229 r52). */
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

/** Tells a screen reader this failed read's wait, once as it starts and once as it ends, however many places show
 *  it: the place registers and the read is what is told (ISS-1229 r54, judge-168). */
export function useWaitAnnounced(error: unknown): void {
  const at = retryAt(error);
  const started = askedWaitWords(error);
  const read = (error as { read?: unknown } | null)?.read;
  const key = at === null ? null : `${typeof read === "string" ? read : ""}@${at}`;
  useEffect(() => {
    if (key === null || at === null || started === null) return;
    return showWait(key, at, started);
  }, [key, at, started]);
}
