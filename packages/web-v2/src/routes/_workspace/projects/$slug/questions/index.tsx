import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "@/features/shell/components/moved-redirect";

// REQ-33 BC-8: the project Questions page was removed; an old link lands on Approvals, where a question waiting on the reader is answered.
function MovedQuestionsPage() {
  return <MovedRedirect page="questions" />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/questions/")({ component: MovedQuestionsPage });
