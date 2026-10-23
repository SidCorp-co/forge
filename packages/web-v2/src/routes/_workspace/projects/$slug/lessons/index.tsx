import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "@/features/shell/components/moved-redirect";

// REQ-33 BC-9: lessons are internal to Forge and no page shows them; an old link lands on the Dashboard, which says so.
function MovedLessonsPage() {
  return <MovedRedirect page="lessons" />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/lessons/")({ component: MovedLessonsPage });
