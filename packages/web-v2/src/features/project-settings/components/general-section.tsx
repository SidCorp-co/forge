"use client";

// Settings → General: what the project is called, the language its prose is written in, and the
// rules its work follows. Every value is a field of the project document, held as one draft and
// saved by one write at the revision read (`PUT /projects/:id/config`, the raw editor's own write).
import Link from "next/link";
import { useId } from "react";
import { CONTENT_LANGUAGE_CHOICES, contentLanguageName, contentLanguageProblem } from "@forge/contracts/content-language";
import { SENSITIVE_DATA_LEVELS } from "@forge/contracts/data-policy";
import { FEEDBACK_VERIFY_WINDOW } from "@forge/contracts/feedback";
import { PERSON_GATES } from "@forge/contracts/person-gates";
import { Input, Skeleton } from "@/design";
import { useProjectDocument, useWriteProjectDocument } from "@/features/project-config";
import { type DocumentDraft, sectionOf, useDocumentDraft } from "@/features/project-config";
import type { ProjectDetail } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { settingsHref } from "../sections";
import { ChoiceSetting, optionsOf, Picker, SaveBar, SettingGroup, SettingRow, SwitchSetting, TextSetting } from "./setting-controls";

const OTHER = "other";
const isChoice = (tag: string) => CONTENT_LANGUAGE_CHOICES.some((c) => c.tag === tag);

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
			{t("settings.project.undeclared")}{" "}
			<Link href={settingsHref(slug, "advanced", "documents")} className="font-semibold text-link hover:underline">
				{t("settings.project.undeclaredAct")}
			</Link>
		</p>
	);
}

function LanguageField({ draft, disabled }: { draft: DocumentDraft; disabled: boolean }) {
	const t = useCopy();
	const id = useId();
	const raw = draft.get(["contentLanguage"]);
	const tag = typeof raw === "string" ? raw : "en";
	const choice = isChoice(tag) ? tag : OTHER;
	const problem = choice === OTHER && tag !== "" ? contentLanguageProblem(tag) : null;
	return (
		<>
			<SettingRow
				label={t("settings.project.general.language")}
				htmlFor={id}
				refusals={draft.refusedAt(["contentLanguage"])}
				control={
					<Picker
						id={id}
						aria-label={t("settings.project.general.language")}
						value={choice}
						disabled={disabled}
						width="sm:max-w-md"
						onChange={(e) => draft.set(["contentLanguage"], e.target.value === OTHER ? "" : e.target.value === "en" ? undefined : e.target.value)}
						options={[...CONTENT_LANGUAGE_CHOICES.map((c) => ({ value: c.tag, label: c.label })), { value: OTHER, label: t("settings.project.general.languageOther") }]}
					/>
				}
			/>
			{choice === OTHER && (
				<SettingRow
					label={t("settings.project.general.languageTag")}
					effect={problem ?? (tag ? contentLanguageName(tag) : undefined)}
					control={
						<Input
							aria-label={t("settings.project.general.languageTag")}
							value={tag}
							maxLength={35}
							disabled={disabled}
							placeholder="pt-BR"
							onChange={(e) => draft.set(["contentLanguage"], e.target.value.trim())}
						/>
					}
				/>
			)}
		</>
	);
}

/** "checkout, storefront" ↔ ["checkout", "storefront"]; emptied, the key is removed. */
function TermsField({ draft, disabled }: { draft: DocumentDraft; disabled: boolean }) {
	const t = useCopy();
	const raw = draft.get(["keepTermsInEnglish"]);
	const terms = Array.isArray(raw) ? raw.join(", ") : "";
	return (
		<SettingRow
			label={t("settings.project.general.keepTerms")}
			refusals={draft.refusedAt(["keepTermsInEnglish"])}
			control={
				<Input
					aria-label={t("settings.project.general.keepTerms")}
					defaultValue={terms}
					key={terms}
					disabled={disabled}
					placeholder={t("settings.project.general.keepTermsPlaceholder")}
					onBlur={(e) => {
						const next = [...new Set(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))];
						if (next.join(", ") !== terms) draft.set(["keepTermsInEnglish"], next.length ? next : undefined);
					}}
				/>
			}
		/>
	);
}

function DaysField({ draft, disabled }: { draft: DocumentDraft; disabled: boolean }) {
	const t = useCopy();
	const path = ["feedback", "verifyWindowDays"];
	const raw = draft.get(path);
	return (
		<SettingRow
			label={t("settings.project.general.verifyWindow")}
			refusals={draft.refusedAt(path)}
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

export function GeneralSection({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
	const t = useCopy();
	const draft = useProjectDraft(project.id);
	const section = sectionOf([draft]);
	if (draft.loading || !draft.ready) return <Skeleton className="h-64 w-full rounded-md" />;
	const off = !canEdit || !draft.declared;

	return (
		<div>
			{!draft.declared && <UndeclaredNotice slug={project.slug} />}
			<SettingGroup title={t("settings.project.general.identity")}>
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
			</SettingGroup>
			<SettingGroup title={t("settings.project.general.languageGroup")}>
				<LanguageField draft={draft} disabled={off} />
				<TermsField draft={draft} disabled={off} />
			</SettingGroup>
			<SettingGroup title={t("settings.project.general.rules")}>
				<SwitchSetting
					draft={draft}
					path={["plan", "approval", "required"]}
					fallback={false}
					label={t("settings.project.general.planApproval")}
					disabled={off}
				/>
				<SwitchSetting
					draft={draft}
					path={["delivery", "verdictsRequired"]}
					fallback={true}
					label={t("settings.project.general.verdicts")}
					disabled={off}
				/>
				{PERSON_GATES.map((gate) => (
					<SwitchSetting
						key={gate}
						draft={draft}
						path={["approvals", gate]}
						fallback={false}
						label={t(`settings.project.general.approvals.${gate}`)}
						disabled={off}
					/>
				))}
				<DaysField draft={draft} disabled={off} />
				<ChoiceSetting
					draft={draft}
					path={["sensitiveData"]}
					unset="off"
					options={optionsOf(t, "settings.project.general.sensitive", SENSITIVE_DATA_LEVELS)}
					label={t("settings.project.general.sensitiveData")}
					disabled={off}
				/>
			</SettingGroup>
			{draft.declared && <SaveBar section={section} canEdit={canEdit} />}
		</div>
	);
}
