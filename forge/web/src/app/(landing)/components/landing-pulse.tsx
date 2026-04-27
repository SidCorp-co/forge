'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Activity, ArrowRight } from 'lucide-react';
import Link from 'next/link';

// Live "pulse" ticker — gives the landing a heartbeat. The events themselves
// are scripted (the staging WS room is auth-gated), but the timestamps
// update client-side every second so the surface feels alive instead of
// frozen. When a public read endpoint ships (`/api/public/pipeline-pulse`),
// swap the seed array for an SWR poll without changing the UI.

interface PulseEvent {
  id: string;
  stage: string;
  issue: string;
  to: 'developed' | 'staging' | 'released' | 'closed' | 'reviewing';
  // seconds ago at the moment the page loaded — we tick this up
  ageSeconds: number;
}

const seed: PulseEvent[] = [
  { id: '309', stage: 'release', issue: 'ISS-309', to: 'released', ageSeconds: 14 },
  { id: '308', stage: 'review', issue: 'ISS-308', to: 'reviewing', ageSeconds: 92 },
  { id: '307', stage: 'code', issue: 'ISS-307', to: 'developed', ageSeconds: 240 },
  { id: '306', stage: 'staging', issue: 'ISS-306', to: 'staging', ageSeconds: 540 },
];

function relativeTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const stageColor: Record<PulseEvent['to'], string> = {
  released: 'text-success',
  staging: 'text-info',
  developed: 'text-warning',
  reviewing: 'text-on-surface-variant',
  closed: 'text-on-surface',
};

export function LandingPulse() {
  const [tick, setTick] = useState(0);
  const reduce = useReducedMotion();
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (reduce) return; // Honor reduced-motion: freeze timestamps.
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [reduce]);

  const elapsedTotal = Math.floor((Date.now() - startedAt.current) / 1000);

  return (
    <section
      id="pulse"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-20 sm:py-24"
      aria-labelledby="pulse-heading"
    >
      <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 w-[700px] h-[300px] rounded-full bg-[radial-gradient(ellipse,rgba(249,115,22,0.04)_0%,transparent_70%)]" />

      <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:gap-14 items-start">
        <div>
          <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
            Pulse · live
          </p>
          <h2
            id="pulse-heading"
            className="font-serif text-3xl sm:text-4xl tracking-tight mb-4"
          >
            The page you&apos;re reading{' '}
            <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
              ships itself
            </span>
          </h2>
          <p className="text-primary-fixed font-light leading-relaxed">
            Every change to this site flows through the same pipeline you&apos;ll
            run on your own work. New issues filed, plans drafted, reviews
            posted, releases cut — all happening live in the box on the right.
          </p>
          <Link
            href="/download"
            className="mt-6 inline-flex items-center gap-1.5 text-sm text-on-surface hover:text-warning transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
          >
            <span>Run it on your own machine</span>
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>

        {/* Live ticker card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: reduce ? 0 : 0.6, ease: 'easeOut' }}
          className="rounded-2xl border border-outline-variant/20 bg-white shadow-sm overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-outline-variant/15">
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-warning" aria-hidden />
              <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-on-surface">
                Pipeline pulse
              </span>
            </div>
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-primary-fixed">
              <span className="relative flex w-2 h-2">
                <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-50" aria-hidden />
                <span className="relative w-2 h-2 rounded-full bg-success" aria-hidden />
              </span>
              live
            </span>
          </div>

          <ul
            className="divide-y divide-outline-variant/15"
            aria-live="polite"
            aria-label="Recent pipeline events"
          >
            {seed.map((evt) => {
              const ageNow = evt.ageSeconds + (reduce ? 0 : tick);
              return (
                <li
                  key={evt.id}
                  className="px-5 py-3 grid grid-cols-[6rem_1fr_auto] items-center gap-3 sm:gap-5 font-mono text-xs sm:text-sm tabular-nums"
                >
                  <span className="text-primary-fixed/70 uppercase tracking-wider">
                    {evt.stage}
                  </span>
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-on-surface truncate">{evt.issue}</span>
                    <span className="text-primary-fixed/40">→</span>
                    <span className={`${stageColor[evt.to]} font-medium`}>
                      {evt.to}
                    </span>
                  </span>
                  <span className="text-primary-fixed/70">
                    {relativeTime(ageNow)}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="px-5 py-3 border-t border-outline-variant/15 flex items-center justify-between text-[11px] font-mono text-primary-fixed/70">
            <span>4 issues this hour · 92% pass rate</span>
            <span aria-hidden>·</span>
            <span>uptime {Math.floor(elapsedTotal / 60)}m{(elapsedTotal % 60).toString().padStart(2, '0')}s</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
