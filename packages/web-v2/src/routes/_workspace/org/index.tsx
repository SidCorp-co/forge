import { createFileRoute } from "@tanstack/react-router";
import { OrgHome } from "@/features/orgs/components/org-home";

function OrgHomePage() {
  return <OrgHome />;
}

export const Route = createFileRoute("/_workspace/org/")({ component: OrgHomePage });
