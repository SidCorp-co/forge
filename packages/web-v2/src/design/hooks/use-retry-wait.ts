"use client";

import { useEffect, useState } from "react";
import { retryAt, retryWaitWords } from "@/lib/utils/retry-rule";

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
