import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useEffect } from "react";
import { PairScreen } from "@/features/pairing/components/pair-screen";
import { useRouter, useSearchParams } from "@/lib/navigation/router";

// A runner's login opens `/pair?code=…` (core's `devices/login-routes.ts` verify URL), where the
// person approves the box. With no code the page only repeated Runners' install command, so it lands
// on Runners, where a device is paired (ISS-1073).
function PairPage() {
  const router = useRouter();
  const code = useSearchParams().get("code")?.trim() ?? "";
  useEffect(() => {
    if (!code) router.replace("/runners");
  }, [router, code]);
  if (!code) return null;
  return (
    <Suspense fallback={null}>
      <PairScreen />
    </Suspense>
  );
}

export const Route = createFileRoute("/_workspace/pair/")({ component: PairPage });
