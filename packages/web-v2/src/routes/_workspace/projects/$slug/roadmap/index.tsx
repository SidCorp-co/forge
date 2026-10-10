import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "@/features/shell/components/moved-redirect";

// REQ-33: the project Roadmap page was removed; an old link lands where its record is read now.
function MovedRoadmapPage() {
  return <MovedRedirect page="roadmap" />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/roadmap/")({ component: MovedRoadmapPage });
