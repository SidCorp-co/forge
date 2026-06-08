"use client";

// Per-project configuration surface (ISS-316). Reached via the gear affordance
// on the project Dashboard header + a ⌘K command — NOT a rail item (the project
// tier is fixed at 6 flat items by design). Tab state lives in `?tab=` via the
// shared `useTabParam` hook (ISS-349) so a tab is linkable and the strip matches
// the other tabbed screens, mirroring the workspace SettingsScreen.
import {
  ScreenTabs,
  ProjectLoader,
  EmptyState,
  ErrorState,
  ProjectMark,
  MonoTag,
  Badge,
  type TabItem,
} from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { useProjectsIncludingArchived, useProject } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatApiError } from "@/lib/api/error";
import { BasicsTab } from "./basics-tab";
import { RepoTab } from "./repo-tab";
import { TestingTab } from "./testing-tab";
import { PipelineTab } from "./pipeline-tab";
import { LabelsTab } from "./labels-tab";
import { MembersTab } from "./members-tab";
import { AgentTab } from "./agent-tab";
import { IntegrationsTab } from "./integrations-tab";
import { AdvancedTab } from "./advanced-tab";

const TAB_VALUES = [
  "basics",
  "repo",
  "testing",
  "pipeline",
  "labels",
  "members",
  "agent",
  "integrations",
  "advanced",
] as const;
type ProjectSettingsTab = (typeof TAB_VALUES)[number];

const TABS: TabItem[] = [
  { value: "basics", label: "Basics" },
  { value: "repo", label: "Repository" },
  { value: "testing", label: "Testing" },
  { value: "pipeline", label: "Pipeline" },
  { value: "labels", label: "Labels" },
  { value: "members", label: "Members" },
  { value: "agent", label: "Agent" },
  { value: "integrations", label: "Integrations" },
  { value: "advanced", label: "Advanced" },
];

export function ProjectSettingsScreen({ slug }: { slug: string }) {
  // Resolve slug → id/role from the projects list, then fetch the full detail
  // (keyed ['project', id]) — the same keys mutations invalidate, so edits
  // reflect after refetch. ISS-353: use the archived-inclusive list so an
  // archived project stays resolvable here (the default ['projects'] list
  // excludes archived rows → the Advanced/Unarchive tab would otherwise vanish
  // the moment a project is archived).
  const projectsQ = useProjectsIncludingArchived();
  const listItem = projectsQ.data?.find((p) => p.slug === slug);
  const detailQ = useProject(listItem?.id);

  const [tab, setTab] = useTabParam<ProjectSettingsTab>(TAB_VALUES, "basics");

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
    <div className="flex min-h-full flex-col">
      <ScreenTabs
        tabs={TABS}
        value={tab}
        onChange={(v) => setTab(v as ProjectSettingsTab)}
        header={
          <>
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
          </>
        }
      />

      <div className="mx-auto w-full max-w-4xl px-4 pb-8 pt-6 sm:px-8">
        {tab === "basics" && <BasicsTab project={project} canEdit={canEdit} />}
        {tab === "repo" && <RepoTab project={project} canEdit={canEdit} />}
        {tab === "testing" && <TestingTab project={project} canEdit={canEdit} />}
        {tab === "pipeline" && <PipelineTab projectId={project.id} canEdit={canEdit} />}
        {tab === "labels" && <LabelsTab projectId={project.id} canEdit={canEdit} />}
        {tab === "members" && <MembersTab projectId={project.id} canEdit={canEdit} />}
        {tab === "agent" && (
          <AgentTab projectId={project.id} canEdit={canEdit || listItem.role === "admin"} />
        )}
        {tab === "integrations" && <IntegrationsTab projectId={project.id} canEdit={canEdit} />}
        {tab === "advanced" && <AdvancedTab project={project} canEdit={canEdit} />}
      </div>
    </div>
  );
}
