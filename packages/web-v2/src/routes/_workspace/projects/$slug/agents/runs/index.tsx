import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useParams, useRouter } from "@/lib/navigation/router";
import { runsListHref } from "@/lib/routes/agents";

// `/agents/runs` with no run id is the Runs list, not a session named "runs": without this route the
// `agents/$sessionId` segment took it and the page read "Couldn't load session — BAD_REQUEST".
function RunsIndexPage() {
  const router = useRouter();
  const slug = useParams<{ slug: string }>()?.slug;
  useEffect(() => {
    if (slug) router.replace(runsListHref(slug));
  }, [router, slug]);
  return null;
}

export const Route = createFileRoute("/_workspace/projects/$slug/agents/runs/")({ component: RunsIndexPage });
