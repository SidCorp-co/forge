
// Settings → General: what the project is called and the rules its work follows. Every value is a
// field of the project document, held as one draft and saved by one write at the revision read
// (`PUT /projects/:id/config`, the raw editor's own write). No step asks a person to approve it here,
// a plan's approval included (routine approval is a defect, owner 2026-11-06), and no language is
// chosen (Forge is English only, owner 2026-10-08): what the document already holds for either is kept
// as written and read by core, and the raw editor under Advanced still writes it (ISS-1071).
import { Link } from "@/lib/navigation/router";
import { SENSITIVE_DATA_LEVELS } from "@forge/contracts/data-policy";
import { FEEDBACK_VERIFY_WINDOW } from "@forge/contracts/feedback";
import { Input, SettingRow, SettingsGroup, Skeleton } from "@/design";
import { useProjectDocument, useWriteProjectDocument } from "@/features/project-config";
import { type DocumentDraft, sectionOf, useDocumentDraft } from "@/features/project-config";
import type { ProjectDetail } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { settingsHref } from "../sections";
import { ChoiceSetting, optionsOf, refusalError, SaveBar, SwitchSetting, TextSetting } from "./setting-controls";

/** The project document a section edits, read and held as one draft. */
export function useProjectDraft(projectId: string): DocumentDraft & { loading: boolean } {
	const q = useProjectDocument(projectId);
	const write = useWriteProjectDocument(projectId);
	return { ...useDocumentDraft(q.data, write, () => q.refetch()), loading: q.isLoading };
}

export function UndeclaredNotice({ slug }: { slug: string }) {
	const t = useCopy();
	return (
		<p className="fg-body-sm border-y border-line py-3 text-muted">
			{t("settings.project.undeclared")} ·{" "}
			<Link href={settingsHref(slug, "advanced", "documents")} className="font-semibold text-link hover:underline">
				{t("settings.project.undeclaredAct")}
			</Link>
		</p>
	);
}

function DaysField({ draft, disabled }: { draft: DocumentDraft; disabled: boolean }) {
	const t = useCopy();
	const path = ["feedback", "verifyWindowDays"];
	const raw = draft.get(path);
	return (
		<SettingRow
			label={t("settings.project.general.verifyWindow")}
			error={refusalError(draft.refusedAt(path))}
			control={
				<Input
					aria-label={t("settings.project.general.verifyWindow")}
					type="number"
					className="sm:max-w-40"
					value={typeof raw === "number" ? String(raw) : ""}
					placeholder={String(FEEDBACK_VERIFY_WINDOW.defaultDays)}
					disabled={disabled}
					onChange={(e) => {
						const v = e.target.value.trim();
						draft.set(path, v === "" ? undefined : Number(v));
					}}
				/>
			}
		/>
	);
}

export function GeneralSettings({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
	const t = useCopy();
	const draft = useProjectDraft(project.id);
	const section = sectionOf([draft]);
	if (draft.loading || !draft.ready) return <Skeleton className="h-64 w-full rounded-md" />;
	const off = !canEdit || !draft.declared;

	return (
		<div>
			{!draft.declared && <UndeclaredNotice slug={project.slug} />}
			<SettingsGroup id="identity" title={t("settings.project.general.identity")}>
				<TextSetting draft={draft} path={["project", "name"]} label={t("settings.project.general.name")} disabled={off} />
				<TextSetting
					draft={draft}
					path={["project", "description"]}
					label={t("settings.project.general.description")}
					placeholder={t("settings.project.general.descriptionPlaceholder")}
					optional
					disabled={off}
				/>
				<SettingRow
					label={t("settings.project.general.address")}
					control={
						<p className="fg-body font-mono text-fg" translate="no">
							/projects/{project.slug}
						</p>
					}
				/>
			</SettingsGroup>
			<SettingsGroup id="rules" title={t("settings.project.general.rules")}>
				<SwitchSetting
					draft={draft}
					path={["delivery", "verdictsRequired"]}
					fallback={true}
					label={t("settings.project.general.verdicts")}
					disabled={off}
				/>
				<DaysField draft={draft} disabled={off} />
				<ChoiceSetting
					draft={draft}
					path={["sensitiveData"]}
					unset="off"
					options={optionsOf(t, "settings.project.general.sensitive", SENSITIVE_DATA_LEVELS)}
					label={t("settings.project.general.sensitiveData")}
					disabled={off}
				/>
			</SettingsGroup>
			{draft.declared && <SaveBar section={section} canEdit={canEdit} />}
		</div>
	);
}
