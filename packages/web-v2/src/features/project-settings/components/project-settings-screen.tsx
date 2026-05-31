"use client";

// Per-project configuration surface (ISS-316). Reached via the gear affordance
// on the project Dashboard header + a ⌘K command — NOT a rail item (the project
// tier is fixed at 6 flat items by design). Tab state lives in the URL hash so
// a tab is linkable, mirroring the workspace SettingsScreen.
import { useEffect, useState } from "react";
import {
  Tabs,
  ProjectLoader,
  EmptyState,
  ErrorState,
  ProjectMark,
  MonoTag,
  Badge,
  type TabItem,
} from "@/design";
import { useProjects, useProject } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatApiError } from "@/lib/api/error";
import { BasicsTab } from "./basics-tab";
import { RepoTab } from "./repo-tab";
import { TestingTab } from "./testing-tab";
import { PipelineTab } from "./pipeline-tab";
import { LabelsTab } from "./labels-tab";
import { MembersTab } from "./members-tab";
import { IntegrationsTab } from "./integrations-tab";

const TABS: TabItem[] = [
  { value: "basics", label: "Basics" },
  { value: "repo", label: "Repository" },
  { value: "testing", label: "Testing" },
  { value: "pipeline", label: "Pipeline" },
  { value: "labels", label: "Labels" },
  { value: "members", label: "Members" },
  { value: "integrations", label: "Integrations" },
];

const VALID = new Set(TABS.map((t) => t.value));

export function ProjectSettingsScreen({ slug }: { slug: string }) {
  // Resolve slug → id/role from the projects list (keyed ['projects']), then
  // fetch the full detail (keyed ['project', id]) — the same keys mutations
  // invalidate, so edits reflect after refetch.
  const projectsQ = useProjects();
  const listItem = projectsQ.data?.find((p) => p.slug === slug);
  const detailQ = useProject(listItem?.id);

  const [tab, setTab] = useState("basics");
  useEffect(() => {
    const fromHash = window.location.hash.replace("#", "");
    if (VALID.has(fromHash)) setTab(fromHash);
  }, []);

  function select(value: string) {
    setTab(value);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${value}`);
    }
  }

  if (projectsQ.isLoading || (listItem && detailQ.isLoading)) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading settings…" />
      </div>
    );
  }

  if (projectsQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
      </div>
    );
  }

  if (!listItem) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <EmptyState
          title="Project not found"
          message="This project doesn't exist or you don't have access to it."
          mascot
        />
      </div>
    );
  }

  if (detailQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(detailQ.error)} onRetry={() => detailQ.refetch()} />
      </div>
    );
  }

  const project = detailQ.data;
  if (!project) return null;

  const glyph = projectGlyph(project.id);
  const canEdit = listItem.role === "owner";

  return (
    <div className="mx-auto w-full min-h-dvh max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6 flex items-center gap-4">
        <ProjectMark
          tint={glyph.tint}
          ink={glyph.ink}
          initials={projectInitials(project.name)}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <h1 className="fg-h2 truncate">Project settings</h1>
          <div className="mt-1 flex items-center gap-2">
            <MonoTag>{project.slug}</MonoTag>
            <Badge tone={canEdit ? "accent" : "neutral"}>{listItem.role}</Badge>
          </div>
        </div>
      </header>

      {!canEdit && (
        <p className="fg-body-sm mb-4 rounded-md border border-line bg-surface px-3 py-2 text-muted">
          You have read-only access — only the project owner can change these settings.
        </p>
      )}

      <div className="mb-6 overflow-x-auto">
        <Tabs tabs={TABS} value={tab} onChange={select} />
      </div>

      {tab === "basics" && <BasicsTab project={project} canEdit={canEdit} />}
      {tab === "repo" && <RepoTab project={project} canEdit={canEdit} />}
      {tab === "testing" && <TestingTab project={project} canEdit={canEdit} />}
      {tab === "pipeline" && <PipelineTab projectId={project.id} canEdit={canEdit} />}
      {tab === "labels" && <LabelsTab projectId={project.id} canEdit={canEdit} />}
      {tab === "members" && <MembersTab projectId={project.id} canEdit={canEdit} />}
      {tab === "integrations" && <IntegrationsTab />}
    </div>
  );
}
