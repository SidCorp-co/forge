"use client";

// Per-project configuration surface (ISS-316). Reached via the gear affordance
// on the project Dashboard header + a ⌘K command — NOT a rail item (the project
// tier is fixed at 6 flat items by design). Tab state lives in `?tab=` via the
// shared `useTabParam` hook (ISS-349) so a tab is linkable and the strip matches
// the other tabbed screens, mirroring the workspace SettingsScreen.
import {
  Badge,
  EmptyState,
  ErrorState,
  MonoTag,
  PageContainer,
  PageTitle,
  ProjectLoader,
  ProjectMark,
  ScreenTabs,
  type TabItem,
} from "@/design";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { useProject, useProjectsIncludingArchived } from "@/features/projects/hooks";
import type { ProjectDetail, ProjectListItem } from "@/features/projects/types";
import { canManageProject, isOrgAdmin } from "@/features/projects/write-access";
import { ProjectRunnersScreen } from "@/features/runners/components/project-runners-screen";
import { formatApiError } from "@/lib/api/error";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { AdvancedTab } from "./advanced-tab";
import { BasicsTab } from "./basics-tab";
import { ConfigTab } from "./config-tab";
import { IntegrationsTab } from "./integrations-tab";
import { LabelsTab } from "./labels-tab";
import { MembersTab } from "./members-tab";
import { ModulesTab } from "./modules-tab";
import { PipelineTab } from "./pipeline-tab";
import { RepoTab } from "./repo-tab";

const TABS = [
	{ value: "basics", label: "Basics" },
	{ value: "repo", label: "Repository" },
	{ value: "config", label: "Configuration" },
	{ value: "runners", label: "Runners" },
	{ value: "pipeline", label: "Pipeline" },
	{ value: "labels", label: "Labels" },
	{ value: "modules", label: "Modules" },
	{ value: "members", label: "Members" },
	{ value: "integrations", label: "Integrations" },
	{ value: "advanced", label: "Advanced" },
] as const satisfies TabItem[];
type ProjectSettingsTab = (typeof TABS)[number]["value"];
const TAB_VALUES = TABS.map((t) => t.value);

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

	const unready =
		projectsQ.isLoading || (listItem && detailQ.isLoading) ? (
			<ProjectLoader label="loading settings…" />
		) : projectsQ.isError ? (
			<ErrorState message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
		) : !listItem ? (
			<EmptyState title="Project not found" message="This project doesn't exist or you don't have access to it." mascot />
		) : detailQ.isError ? (
			<ErrorState message={formatApiError(detailQ.error)} onRetry={() => detailQ.refetch()} />
		) : null;
	if (unready) return <div className="grid min-h-[60vh] place-items-center">{unready}</div>;

	const project = detailQ.data;
	if (!listItem || !project) return null;
	// Settings-level edits require org owner/admin on the project's org; member
	// and label management only needs the effective project admin role.
	const canEdit = isOrgAdmin(listItem.orgRole);
	const isProjectAdmin = canManageProject(listItem.role);
	const canManage = canEdit || isProjectAdmin;

	return (
		<div className="flex min-h-full flex-col">
			<ScreenTabs
				tabs={[...TABS]}
				value={tab}
				onChange={(v) => setTab(v as ProjectSettingsTab)}
				header={<SettingsHeader project={project} role={listItem.role} canEdit={canEdit} isProjectAdmin={isProjectAdmin} />}
			/>
			<PageContainer>
				<div className={tab === "integrations" ? undefined : "max-w-4xl"}>
					{tab === "basics" && <BasicsTab project={project} canEdit={canEdit} />}
					{tab === "repo" && <RepoTab project={project} />}
					{tab === "config" && <ConfigTab project={project} canEdit={canEdit} />}
					{tab === "runners" && <ProjectRunnersScreen projectId={project.id} canEdit={canManage} embedded />}
					{tab === "pipeline" && <PipelineTab projectId={project.id} canEdit={canEdit} slug={project.slug} />}
					{tab === "labels" && <LabelsTab projectId={project.id} canEdit={canManage} />}
					{tab === "modules" && <ModulesTab projectId={project.id} canEdit={canManage} />}
					{tab === "members" && <MembersTab projectId={project.id} canEdit={canManage} />}
					{tab === "integrations" && <IntegrationsTab projectId={project.id} canEdit={canEdit} />}
					{tab === "advanced" && <AdvancedTab project={project} canEdit={canEdit} />}
				</div>
			</PageContainer>
		</div>
	);
}

function SettingsHeader({
	project,
	role,
	canEdit,
	isProjectAdmin,
}: {
	project: ProjectDetail;
	role: ProjectListItem["role"];
	canEdit: boolean;
	isProjectAdmin: boolean;
}) {
	const glyph = projectGlyph(project.id);
	return (
		<>
			<header className="mb-6 flex items-center gap-4">
				<ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(project.name)} size={40} />
				<div className="min-w-0 flex-1">
					<PageTitle className="fg-h2 truncate">Project settings</PageTitle>
					<div className="mt-1 flex items-center gap-2">
						<MonoTag>{project.slug}</MonoTag>
						<Badge tone={canEdit ? "accent" : "neutral"}>{role ?? "org"}</Badge>
					</div>
				</div>
			</header>
			{!canEdit && (
				<p className="fg-body-sm mb-4 rounded-md border border-line bg-surface px-3 py-2 text-muted">
					{isProjectAdmin
						? "Basics, Repo, Configuration, Pipeline, Integrations and Advanced need an org owner/admin — you can still manage Members and Labels."
						: "You have read-only access to these settings."}
				</p>
			)}
		</>
	);
}
