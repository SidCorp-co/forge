'use client';

// ISS-269 — see ../landing-trust.tsx for rationale.
import dynamic from 'next/dynamic';

const DeliveryMetricsImpl = dynamic(
  () => import('./delivery-metrics-impl').then((m) => ({ default: m.DeliveryMetrics })),
  { ssr: false },
);

export function DeliveryMetrics() {
  return <DeliveryMetricsImpl />;
}
