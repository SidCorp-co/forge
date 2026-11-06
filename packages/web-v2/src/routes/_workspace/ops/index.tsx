import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useRouter } from "@/lib/navigation/router";

// ISS-1069: Ops was one of five workspace overviews that each read the org a different way; Activity is
// the one cross-project screen now, and a link kept to Ops lands there.
function OpsMovedPage() {
  const router = useRouter();
  useEffect(() => router.replace("/activity"), [router]);
  return null;
}

export const Route = createFileRoute("/_workspace/ops/")({ component: OpsMovedPage });
