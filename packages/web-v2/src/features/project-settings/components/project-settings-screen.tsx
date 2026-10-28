
// Per-project settings (ISS-316), grouped by what a person comes to change rather than by the
// document each value is stored in: General, People, Work, Delivery (with the environments), Gates, Preview,
// Testing (the accounts a run tests with), Connections, and Advanced for the raw documents. The section lives in `?tab=`; a link written against the old flat tabs is
// moved to the section that now holds its content (`sections.ts:LEGACY_TABS`). The page is the detail
// template: the section's groups in the main column, and a rail beside it listing them (the group in
// view marked); below 1024px the rail is not drawn and one contents menu at the top stands in.
import { useEffect, useState } from "react";
import { CONTENTS_LABEL, ContentsList, ContentsMenu, DetailLayout, DetailPane, EmptyState, ErrorState, FactsRail, PageTitle, ProjectLoader, ScreenTabs, type TabItem, useContentsIn } from "@/design";
import { useProject, useProjectsIncludingArchived } from "@/features/projects";
import type { ProjectDetail } from "@/features/projects";
import { canManageProject, isOrgAdmin } from "@/features/projects";
import { ProjectRunnersScreen } from "@/features/runners";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { LEGACY_TABS, SETTINGS_SECTIONS, type SettingsSection } from "../sections";
import { AdvancedSettings } from "./advanced-tab";
import { DeliverySettings } from "./delivery-section";
import { GatesSettings } from "./gates-section";
import { GeneralSettings } from "./general-section";
import { IntegrationsTab } from "./integrations-tab";
import { LabelsTab } from "./labels-tab";
import { MembersTab } from "./members-tab";
import { ModulesTab } from "./modules-tab";
import { PreviewSettings } from "./preview-section";
import { ShareSettings } from "./shares-section";
import { TestingSettings } from "./testing-tab";

const LABEL: Record<SettingsSection, ProductCopyKey> = {
	general: "settings.project.section.general",
	people: "settings.project.section.people",
	work: "settings.project.section.work",
	delivery: "settings.project.section.delivery",
	gates: "settings.project.section.gates",
	preview: "previews.settings.section",
	testing: "settings.project.section.testing",
	connections: "settings.project.section.connections",
	advanced: "settings.project.section.advanced",
};

/** An old `?tab=` becomes its section, keeping the place it pointed at as the hash. */
function useLegacyTab(setTab: (s: SettingsSection) => void) {
	useEffect(() => {
		const raw = new URLSearchParams(window.location.search).get("tab");
		const moved = raw ? LEGACY_TABS[raw] : undefined;
		if (!moved) return;
		if (moved.anchor && !window.location.hash) window.history.replaceState(window.history.state, "", `#${moved.anchor}`);
		setTab(moved.section);
	}, [setTab]);
}

/** The place a link names inside a section, brought into view once the section has drawn. */
function useAnchor(section: SettingsSection, ready: boolean) {
	useEffect(() => {
		if (!ready || !section) return;
		const id = window.location.hash.slice(1);
		if (!id) return;
		const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: "start" }));
		return () => cancelAnimationFrame(frame);
	}, [section, ready]);
}

export function ProjectSettingsScreen({ slug }: { slug: string }) {
	const t = useCopy();
	// The archived-inclusive list (ISS-353), so an archived project stays resolvable here.
	const projectsQ = useProjectsIncludingArchived();
	const listItem = projectsQ.data?.find((p) => p.slug === slug);
	const detailQ = useProject(listItem?.id);
	const [tab, setTab] = useTabParam<SettingsSection>(SETTINGS_SECTIONS, "general");
	const [region, setRegion] = useState<HTMLDivElement | null>(null);
	const contents = useContentsIn(region);
	useLegacyTab(setTab);
	useAnchor(tab, Boolean(detailQ.data));

	const unready =
		projectsQ.isLoading || (listItem && detailQ.isLoading) ? (
			<ProjectLoader label={t("settings.project.loading")} />
		) : projectsQ.isError ? (
			<ErrorState message={formatApiError(projectsQ.error)} onRetry={() => void projectsQ.refetch()} />
		) : !listItem ? (
			<EmptyState title={t("settings.project.notFoundTitle")} message={t("settings.project.notFoundBody")} mascot />
		) : detailQ.isError ? (
			<ErrorState message={formatApiError(detailQ.error)} onRetry={() => void detailQ.refetch()} />
		) : null;
	if (unready) return <div className="grid min-h-96 place-items-center">{unready}</div>;

	const project = detailQ.data;
	if (!listItem || !project) return null;
	// The project's own values need an org owner/admin; members, labels and modules the project admin role.
	const canEdit = isOrgAdmin(listItem.orgRole);
	const canManage = canEdit || canManageProject(listItem.role);
	const tabs: TabItem[] = SETTINGS_SECTIONS.map((value) => ({ value, label: t(LABEL[value]) }));

	return (
		<div className="flex min-h-full flex-col">
			<ScreenTabs
				tabs={tabs}
				value={tab}
				onChange={(v) => setTab(v as SettingsSection)}
				width="max-w-none"
				header={<Header project={project} canEdit={canEdit} canManage={canManage} />}
			/>
			<DetailLayout
				testId="settings-layout"
				// the rail lists the section's groups and holds no facts: below 1024px the menu at the top stands in
				contentsRail
				rail={
					<FactsRail label={t("settings.project.contents")}>
						<ContentsList items={contents} label={t("settings.project.contents")} testId="settings-contents" />
					</FactsRail>
				}
			>
				<DetailPane label={t(LABEL[tab])} testId="settings-pane">
					<ContentsMenu items={contents} label={t("settings.project.contents")} testId="settings-contents-menu" className="-mt-2 mb-2 lg:hidden" />
					<div ref={setRegion}>
					{tab === "general" && <GeneralSettings project={project} canEdit={canEdit} />}
					{tab === "people" && (
						<>
							<div id="members" className="scroll-mt-24" {...{ [CONTENTS_LABEL]: t("settings.project.people.members") }}>
								<MembersTab projectId={project.id} canEdit={canManage} />
							</div>
							<div id="shares" className="scroll-mt-24 border-t border-line" {...{ [CONTENTS_LABEL]: t("settings.project.people.shareLinks") }}>
								<ShareSettings projectId={project.id} isAdmin={canManage} />
							</div>
						</>
					)}
					{tab === "work" && (
						<>
							<div id="modules" className="scroll-mt-24" {...{ [CONTENTS_LABEL]: t("settings.project.work.modules") }}>
								<ModulesTab projectId={project.id} canEdit={canManage} />
							</div>
							<div id="labels" className="scroll-mt-24 border-t border-line" {...{ [CONTENTS_LABEL]: t("settings.project.work.labels") }}>
								<LabelsTab projectId={project.id} canEdit={canManage} />
							</div>
						</>
					)}
					{tab === "delivery" && <DeliverySettings project={project} canEdit={canEdit} />}
					{tab === "gates" && <GatesSettings projectId={project.id} slug={project.slug} access={listItem} />}
					{tab === "preview" && <PreviewSettings projectId={project.id} slug={project.slug} canEdit={canEdit} />}
					{tab === "testing" && <TestingSettings projectId={project.id} canEdit={canEdit} />}
					{tab === "connections" && (
						<>
							<div id="integrations" className="scroll-mt-24" {...{ [CONTENTS_LABEL]: t("integrations.title") }}>
								<IntegrationsTab projectId={project.id} canEdit={canEdit} />
							</div>
							<div id="runners" className="mt-8 scroll-mt-24 border-t border-line pt-6" {...{ [CONTENTS_LABEL]: t("settings.project.runnersHeading") }}>
								{/* the runner screen titles its own parts (Add a device, Assigned devices); the contents name the place */}
								<ProjectRunnersScreen projectId={project.id} canEdit={canManage} embedded />
							</div>
						</>
					)}
					{tab === "advanced" && <AdvancedSettings project={project} canEdit={canEdit} />}
					</div>
				</DetailPane>
			</DetailLayout>
		</div>
	);
}

function Header({ project, canEdit, canManage }: { project: ProjectDetail; canEdit: boolean; canManage: boolean }) {
	const t = useCopy();
	return (
		<>
			<PageTitle after={<span className="fg-body text-muted">{project.name}</span>}>{t("settings.project.title")}</PageTitle>
			{!canEdit && (
				<p className="fg-body-sm mb-4 text-muted">
					{canManage ? t("settings.project.access.projectAdmin") : t("settings.project.access.readOnly")}
				</p>
			)}
		</>
	);
}
