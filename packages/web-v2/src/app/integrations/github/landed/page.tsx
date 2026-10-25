"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { GithubLanded } from "@/features/integrations/components/github-landed";

function Landed() {
  return <GithubLanded code={useSearchParams().get("code")} />;
}

export default function GithubLandedPage() {
  return (
    <Suspense fallback={null}>
      <Landed />
    </Suspense>
  );
}
