"use client";

// The project's decision log page body: the filter choices are read here, above the features that
// own them, and the log itself is the comments feature's.

import { type DecisionFilterOptions, ProjectDecisions } from "@/features/comments/components/project-decisions";
import { useProjectMembers } from "@/features/issues/hooks";
import { useWorkflows } from "@/features/workflows/hooks";
import { useRequirements } from "../hooks";

export function DecisionLog({ projectId, slug }: { projectId: string; slug: string }) {
  const reqs = useRequirements(projectId);
  const flows = useWorkflows(projectId);
  const members = useProjectMembers(projectId);
  const options: DecisionFilterOptions = {
    requirements: (reqs.data?.requirements ?? []).map((r) => ({ value: r.key, label: `${r.key} ${r.title}` })),
    workflows: (flows.data?.workflows ?? []).map((w) => ({ value: w.document.flow, label: w.document.title || w.document.flow })),
    who: (members.data ?? []).map((m) => ({ value: m.userId, label: m.displayName ?? m.email })),
  };
  return <ProjectDecisions projectId={projectId} slug={slug} options={options} />;
}
