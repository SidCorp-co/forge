"use client";

import { useParams } from "next/navigation";
import { ProjectSettingsScreen } from "@/features/project-settings/components/project-settings-screen";

export default function ProjectSettingsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  if (!slug) return null;
  return <ProjectSettingsScreen slug={slug} />;
}
