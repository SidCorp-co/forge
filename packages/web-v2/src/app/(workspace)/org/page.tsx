"use client";

// Org home route (ISS-470) — `/org` reflects the active org (name, projects,
// members), reachable one click from the chrome org switcher. Built entirely on
// existing org endpoints (orgs / members / projects-by-org); no backend change.
import { OrgHome } from "@/features/orgs/components/org-home";

export default function OrgHomePage() {
  return <OrgHome />;
}
