"use client";

// Per-project settings (ISS-316), grouped by what a person comes to change rather than by the
// document each value is stored in: General, People, Work, Delivery, Connections, and Advanced for
// the raw documents. The section lives in `?tab=`; a link written against the old flat tabs is
// moved to the section that now holds its content (`sections.ts:LEGACY_TABS`).
import { useEffect } from "react";
import { EmptyState, ErrorState, PageContainer, PageTitle, ProjectLoader, ScreenTabs, type TabItem } from "@/design";
import { useProject, useProjectsIncludingArchived } from "@/features/projects/hooks";
import type { ProjectDetail } from "@/features/projects/types";
import { canManageProject, isOrgAdmin } from "@/features/projects/write-access";
import { ProjectRunnersScreen } from "@/features/runners/components/project-runners-screen";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { LEGACY_TABS, SETTINGS_SECTIONS, type SettingsSection } from "../sections";
import { AdvancedSection } from "./advanced-tab";
import { DeliverySection } from "./delivery-section";
import { GeneralSection } from "./general-section";
import { IntegrationsTab } from "./integrations-tab";
import { LabelsTab } from "./labels-tab";
import { MembersTab } from "./members-tab";
import { ModulesTab } from "./modules-tab";
import { PreviewSection } from "./preview-section";
import { SharesSection } from "./shares-section";

const LABEL: Record<SettingsSection, ProductCopyKey> = {
	general: "settings.project.section.general",
	people: "settings.project.section.people",
	work: "settings.project.section.work",
	delivery: "settings.project.section.delivery",
	preview: "previews.settings.section",
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
	useLegacyTab(setTab);
	useAnchor(tab, Boolean(detailQ.data));

	const unready =
		projectsQ.isLoading || (listItem && detailQ.isLoading) ? (
			<ProjectLoader label={t("settings.project.loading")} />
		) : projectsQ.isError ? (
			<ErrorState message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
		) : !listItem ? (
			<EmptyState title={t("settings.project.notFoundTitle")} message={t("settings.project.notFoundBody")} mascot />
		) : detailQ.isError ? (
			<ErrorState message={formatApiError(detailQ.error)} onRetry={() => detailQ.refetch()} />
		) : null;
	if (unready) return <div className="grid min-h-[60vh] place-items-center">{unready}</div>;

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
				header={<Header project={project} canEdit={canEdit} canManage={canManage} />}
			/>
			<PageContainer>
				<div className={tab === "connections" ? undefined : "max-w-4xl"}>
					{tab === "general" && <GeneralSection project={project} canEdit={canEdit} />}
					{tab === "people" && (
						<>
							<MembersTab projectId={project.id} canEdit={canManage} />
							<div id="shares" className="scroll-mt-24 border-t border-line">
								<SharesSection projectId={project.id} isAdmin={canManage} />
							</div>
						</>
					)}
					{tab === "work" && (
						<>
							<div id="modules" className="scroll-mt-24">
								<ModulesTab projectId={project.id} canEdit={canManage} />
							</div>
							<div id="labels" className="scroll-mt-24 border-t border-line">
								<LabelsTab projectId={project.id} canEdit={canManage} />
							</div>
						</>
					)}
					{tab === "delivery" && <DeliverySection project={project} canEdit={canEdit} />}
					{tab === "preview" && <PreviewSection projectId={project.id} slug={project.slug} canEdit={canEdit} />}
					{tab === "connections" && (
						<>
							<div id="integrations" className="scroll-mt-24">
								<IntegrationsTab projectId={project.id} canEdit={canEdit} />
							</div>
							<div id="runners" className="mt-8 max-w-4xl scroll-mt-24 border-t border-line pt-6">
								<h2 className="fg-h3 text-accent-text!">{t("settings.project.runnersHeading")}</h2>
								<ProjectRunnersScreen projectId={project.id} canEdit={canManage} embedded />
							</div>
						</>
					)}
					{tab === "advanced" && <AdvancedSection project={project} canEdit={canEdit} />}
				</div>
			</PageContainer>
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
