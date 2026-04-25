'use client';

// ISS-269 — see landing-trust.tsx for rationale. Showcase uses ScrollTrigger
// at module load and trips the same RSC chunk-eval race.
import dynamic from 'next/dynamic';

const LandingShowcaseImpl = dynamic(
  () => import('./landing-showcase-impl').then((m) => ({ default: m.LandingShowcase })),
  { ssr: false },
);

export function LandingShowcase() {
  return <LandingShowcaseImpl />;
}
