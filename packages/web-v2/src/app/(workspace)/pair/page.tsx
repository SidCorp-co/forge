"use client";

import { Suspense } from "react";
import { PairScreen } from "@/features/pairing/components/pair-screen";

export default function PairPage() {
  return (
    <Suspense fallback={null}>
      <PairScreen />
    </Suspense>
  );
}
