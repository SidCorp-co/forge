"use client";

// A project's API page (`/projects/[slug]/ecosystem/api`); built by `ecosystemRoutes.apiPage`.
import { useParams } from "next/navigation";
import { ApiPageScreen } from "@/features/ecosystem/components/api-page-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";

export default function ProjectApiPage() {
  const params = useParams<{ slug: string }>();
  return (
    <EcosystemPage slug={params?.slug} section="api" title="Project API">
      {(project) => <ApiPageScreen projectId={project.id} slug={project.slug} />}
    </EcosystemPage>
  );
}
