import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { PairScreen } from "@/features/pairing/components/pair-screen";

function PairPage() {
  return (
    <Suspense fallback={null}>
      <PairScreen />
    </Suspense>
  );
}

export const Route = createFileRoute("/_workspace/pair/")({ component: PairPage });
