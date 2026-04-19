'use client';

import { DeliveryMetrics } from './trust/delivery-metrics';

export function LandingSpeedProof() {
  return (
    <section id="speed-proof" className="bg-surface-container-low py-24"><div className="max-w-5xl mx-auto px-6">
      <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
        Speed Proof
      </p>
      <h2 className="font-serif text-3xl sm:text-4xl tracking-tight mb-3">
        Numbers don&apos;t lie.
      </h2>
      <p className="text-primary-fixed max-w-lg text-base font-light leading-relaxed mb-4">
        Real delivery metrics from real engagements. Speed is a feature, not a compromise.
      </p>

      <DeliveryMetrics />
    </div></section>
  );
}
