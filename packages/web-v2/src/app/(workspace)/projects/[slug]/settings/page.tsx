"use client";

// Per-project settings (`/projects/[slug]/settings`). A nested route that is
// deliberately NOT a rail item (the project tier is fixed at 6 flat items by
// design) — reached via the gear affordance on the project Dashboard header and
// a ⌘K command. The screen resolves slug → project internally (ISS-316).
import { useParams } from "next/navigation";
import { ProjectSettingsScreen } from "@/features/project-settings/components/project-settings-screen";

export default function ProjectSettingsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  if (!slug) return null;
  return <ProjectSettingsScreen slug={slug} />;
}
