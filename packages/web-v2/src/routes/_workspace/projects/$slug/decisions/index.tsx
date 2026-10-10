import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "@/features/shell/components/moved-redirect";

// REQ-33: the project Decisions page was removed; an old link lands where its record is read now.
function MovedDecisionsPage() {
  return <MovedRedirect page="decisions" />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/decisions/")({ component: MovedDecisionsPage });
