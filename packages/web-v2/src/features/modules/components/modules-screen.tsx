"use client";

// The Modules screen opens on the business modules, the roots of the module tree, with every count
// rolled up from the modules beneath them; a module's children are on its own page.

import { EmptyState, ErrorState, PageTitle, ProjectLoader } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCodeTrace, useModuleRollup } from "../hooks";
import { ModuleLevel } from "./module-level";

export function ModulesScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useModuleRollup(projectId);
  const trace = useCodeTrace().data;
  const title = <PageTitle>Modules</PageTitle>;

  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ProjectLoader label="loading modules…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="modules-screen">
      {title}
      {q.data.modules.length === 0 ? (
        <div className="px-5 py-10">
          <EmptyState title="No module has been declared" message="A module is a label of kind module. Issues are attributed to one, and it appears here with what is open and what landed." />
        </div>
      ) : (
        <ModuleLevel
          projectId={projectId}
          slug={slug}
          data={q.data}
          scope={null}
          toolbar={
            <p className="flex justify-end gap-5 border-b border-line-subtle px-5 py-2.5 text-12 text-subtle max-md:px-3">
              {trace ? (
                <span data-testid="modules-untraced" title={trace.units.filter((u) => u.serves.length === 0).map((u) => `${u.scope}:${u.unit}`).join(", ") || "Every unit serves a requirement or workflow step"}>
                  Code units untraced {trace.untraced} of {trace.total}
                </span>
              ) : null}
              <span title="Open issues in no module are not counted in any row">Open issues in no module {q.data.unassigned.open}</span>
            </p>
          }
        />
      )}
    </div>
  );
}
