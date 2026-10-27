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
  useLeaveGuardAttempt,
} from "@/design";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import {
	useProject,
	useProjectsIncludingArchived,
} from "@/features/projects/hooks";
import { ProjectRunnersScreen } from "@/features/runners/components/project-runners-screen";
import { ProjectsUnread } from "@/features/projects/components/project-missing";
import { formatApiError } from "@/lib/api/error";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { AdvancedTab } from "./advanced-tab";
import { BasicsTab } from "./basics-tab";
import { IntegrationsTab } from "./integrations-tab";
import { LabelsTab } from "./labels-tab";
import { MembersTab } from "./members-tab";
import { ModulesTab } from "./modules-tab";
import { MemoryTab } from "./memory-tab";
import { PipelineTab } from "./pipeline-tab";
import { ShapeTab } from "./shape-tab";

export const TAB_VALUES = [
	"general",
	"shape",
	"pipeline",
	"runners",
	"integrations",
	"members",
	"taxonomy",
	"memory",
] as const;
type ProjectSettingsTab = (typeof TAB_VALUES)[number];

export const TABS: TabItem[] = [
	{ value: "general", label: "General" },
	{ value: "shape", label: "Shape & release" },
	{ value: "pipeline", label: "Pipeline" },
	{ value: "runners", label: "Runners" },
	{ value: "integrations", label: "Integrations" },
	{ value: "members", label: "Members" },
	{ value: "taxonomy", label: "Labels & modules" },
	{ value: "memory", label: "Memory" },
];

/** The eleven-tab screen's addresses, each sent to the tab that now holds what it showed. */
export const TAB_ALIASES: Readonly<Record<string, ProjectSettingsTab>> = {
	basics: "general",
	advanced: "general",
	repo: "shape",
	testing: "shape",
	labels: "taxonomy",
	modules: "taxonomy",
};

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

	const [tab, setTab] = useTabParam<ProjectSettingsTab>(TAB_VALUES, "general", TAB_ALIASES);
	const leave = useLeaveGuardAttempt();

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
				<ProjectsUnread error={projectsQ.error} />
			</div>
		);
	}

	if (!listItem) {
		return (
			<div className="grid min-h-[60vh] place-items-center">
				<EmptyState
					level={1}
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
				<ErrorState
					level={1}
					title="Couldn't load this project's settings"
					message={formatApiError(detailQ.error)}
					onRetry={() => detailQ.refetch()}
				/>
			</div>
		);
	}

	const project = detailQ.data;
	if (!project) return null;

	const glyph = projectGlyph(project.id);
	// Settings-level edits require org owner/admin on the project's org; member
	// and label management only needs the effective project admin role.
	const canEdit = listItem.orgRole === "owner" || listItem.orgRole === "admin";
	const isProjectAdmin = listItem.role === "admin";

	return (
		<div className="flex min-h-full flex-col">
			<ScreenTabs
				tabs={TABS}
				value={tab}
				onChange={(v) => leave(() => setTab(v as ProjectSettingsTab))}
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
								<PageTitle className="fg-h2 truncate">Project settings</PageTitle>
								<div className="mt-1 flex items-center gap-2">
									<MonoTag>{project.slug}</MonoTag>
									<Badge tone={canEdit ? "accent" : "neutral"}>
										{listItem.role ?? "org"}
									</Badge>
								</div>
							</div>
						</header>

						{!canEdit && (
							<p className="fg-body-sm mb-4 border-b border-line pb-3 text-muted">
								{isProjectAdmin
									? "General, Shape & release and Pipeline need an org owner/admin — you can still manage Members, Labels & modules, Runners and Memory. Integrations say what your role in this project lets you do."
									: "You have read-only access to these settings."}
							</p>
						)}
					</>
				}
			/>

			<PageContainer>
				<div className="max-w-4xl">
					{tab === "general" && (
						<>
							<BasicsTab project={project} canEdit={canEdit} />
							<AdvancedTab project={project} canEdit={canEdit} />
						</>
					)}
					{tab === "shape" && <ShapeTab project={project} canEdit={canEdit} />}
					{tab === "pipeline" && (
						<PipelineTab
							projectId={project.id}
							canEdit={canEdit}
							slug={project.slug}
						/>
					)}
					{tab === "runners" && (
						<ProjectRunnersScreen
							projectId={project.id}
							canEdit={canEdit || isProjectAdmin}
							embedded
						/>
					)}
					{tab === "integrations" && (
						<IntegrationsTab projectId={project.id} />
					)}
					{tab === "members" && (
						<MembersTab
							projectId={project.id}
							canEdit={canEdit || isProjectAdmin}
						/>
					)}
					{tab === "taxonomy" && (
						<>
							<LabelsTab
								projectId={project.id}
								canEdit={canEdit || isProjectAdmin}
							/>
							<ModulesTab
								projectId={project.id}
								canEdit={canEdit || isProjectAdmin}
							/>
						</>
					)}
					{tab === "memory" && (
						<MemoryTab
							project={project}
							canEdit={canEdit || isProjectAdmin}
						/>
					)}
				</div>
			</PageContainer>
		</div>
	);
}
