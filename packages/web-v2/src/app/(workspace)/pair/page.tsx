"use client";

import { Suspense } from "react";
import { PairScreen } from "@/features/pairing/components/pair-screen";

/**
 * `/pair` — browser approval for the runner device-login flow (ISS-305).
 * Wrapped in Suspense because `PairScreen` reads `useSearchParams()`.
 */
export default function PairPage() {
  return (
    <Suspense fallback={null}>
      <PairScreen />
    </Suspense>
  );
}
