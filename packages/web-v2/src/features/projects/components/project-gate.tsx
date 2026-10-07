"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";

export function ProjectGate({
  label,
  notFound,
  children,
}: {
  label: string;
  notFound?: { title: string; message: string };
  children: (p: ProjectListItem) => React.ReactNode;
}) {
  const t = useCopy();
  const missing = notFound ?? { title: t("dash.notFound"), message: t("dash.notFoundMessage") };
  const params = useParams<{ slug: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  const project = projects?.find((p) => p.slug === params?.slug);
  if (!isLoading && !isError && project) return <>{children(project)}</>;
  return (
    <div className="grid min-h-[60vh] place-items-center">
      {isLoading ? (
        <ProjectLoader label={label} />
      ) : isError ? (
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      ) : (
        <ErrorState title={missing.title} message={missing.message} />
      )}
    </div>
  );
}
