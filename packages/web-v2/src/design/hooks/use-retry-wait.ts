"use client";

import { useEffect, useState } from "react";
import { retryAt, retryWaitWords } from "@/lib/utils/retry-rule";

/**
 * How long until a failed read can be asked again, counted down once a second; null where there is no wait,
 * and null again once it reaches zero, which is when its Retry comes back (ISS-1229 r51, judge-158: a wait
 * worked out once still said 30 seconds 47 seconds later).
 */
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
