'use client';

// ISS-269 — load the gsap-using implementation client-only. Next 16's RSC
// pass evaluates `'use client'` modules during the SSR HTML render, which
// pulled gsap + ScrollTrigger into a chunk where ScrollTrigger.create() ran
// before the plugin was bound to gsap (`Cannot read properties of undefined
// (reading '_gsap')`). `ssr: false` keeps the module entirely out of the
// server pass; per-effect registerPlugin still guards the chunk-eval race.
import dynamic from 'next/dynamic';

const LandingTrustImpl = dynamic(
  () => import('./landing-trust-impl').then((m) => ({ default: m.LandingTrust })),
  { ssr: false },
);

export function LandingTrust() {
  return <LandingTrustImpl />;
}
