import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "@/features/shell/components/moved-redirect";

// REQ-33: the project Memory page was removed; an old link lands where its record is read now.
function MovedMemoryPage() {
  return <MovedRedirect page="memory" />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/memory/")({ component: MovedMemoryPage });
