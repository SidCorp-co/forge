'use client';

import { useState, useEffect, useRef } from 'react';

/** Countdown for quota-queued sessions. Shows time remaining until expected reset. */
export function QuotaCountdown({ exhaustedAt }: { exhaustedAt: string }) {
  const [text, setText] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    // Estimate reset: quotaExhaustedAt + look for a nearby hour boundary, fallback to +1h
    const exhausted = new Date(exhaustedAt).getTime();
    const resetAt = exhausted + 60 * 60 * 1000; // default 1h after exhaustion

    const update = () => {
      const diff = resetAt - Date.now();
      if (diff <= 0) { setText('soon'); return; }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setText(m > 0 ? `~${m}m ${s}s` : `${s}s`);
    };
    update();
    timerRef.current = setInterval(update, 1000);
    return () => clearInterval(timerRef.current);
  }, [exhaustedAt]);

  return <span className="text-warning">{text}</span>;
}
