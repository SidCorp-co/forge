import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useParams, useRouter } from "@/lib/navigation/router";

// ISS-1073: the Pipeline board repeated Issues, a column per status with no act of its own; a link kept
// to it lands on Issues › Waves, which reads the same work by the run that takes it.
function PipelineMovedPage() {
  const router = useRouter();
  const slug = useParams<{ slug: string }>()?.slug;
  useEffect(() => {
    if (slug) router.replace(`/projects/${encodeURIComponent(slug)}/issues?group=waves`);
  }, [router, slug]);
  return null;
}

export const Route = createFileRoute("/_workspace/projects/$slug/pipeline/")({ component: PipelineMovedPage });
