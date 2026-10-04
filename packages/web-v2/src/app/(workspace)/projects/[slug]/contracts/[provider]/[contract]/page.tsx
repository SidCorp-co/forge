"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { ContractScreen } from "@/features/contracts/components/contract-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectContractPage() {
  const params = useParams<{ slug: string; provider: string; contract: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading contract…" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }
  const project = projects?.find((p) => p.slug === params?.slug);
  if (!project || !params?.provider || !params?.contract) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      </div>
    );
  }
  const ref = `${decodeURIComponent(params.provider)}/${decodeURIComponent(params.contract)}`;
  return <ContractScreen projectId={project.id} slug={project.slug} contractRef={ref} />;
}
