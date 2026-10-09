"use client";

// Settings → Preview: the project document's `preview` key (how a run's dev server starts for a live
// preview, REQ-39 BC-11) and its `fastLane` key (which approved changes may skip the full gates). Both
// are fields of the one project document, held as one draft and saved by the section's one bar at the
// revision read. An emptied field leaves its key; an object left with no key is removed, so an unset
// preview reads as "filled from the repository" (`detectPreviewSettings`) and never as an empty object
// core would have to refuse. What core refuses is shown at the field it names.

import { useId } from "react";
import { PREVIEW_LIMITS } from "@forge/contracts/preview";
import { Input, Skeleton } from "@/design";
import type { DocumentDraft } from "@/features/project-config/use-document-draft";
import { sectionOf } from "@/features/project-config/use-document-draft";
import { useCopy } from "@/lib/i18n/interface-language";
import { UndeclaredNotice, useProjectDraft } from "./general-section";
import { SaveBar, SettingGroup, SettingRow } from "./setting-controls";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Sets one key of an object-valued key of the document, dropping the object when no key is left. */
function setKey(draft: DocumentDraft, root: "preview" | "fastLane", key: string, value: unknown) {
	const next: Obj = { ...obj(draft.get([root])) };
	if (value === undefined) delete next[key];
	else next[key] = value;
	// the empty `paths` list the fast lane keeps while other keys are set says nothing by itself
	const bare = Object.keys(next).every((k) => root === "fastLane" && k === "paths" && Array.isArray(next[k]) && (next[k] as unknown[]).length === 0);
	if (bare) draft.set([root], undefined);
	// the fast lane's `paths` is required once the key exists; an empty list is what "nothing takes it" means
	else draft.set([root], root === "fastLane" && next.paths === undefined ? { paths: [], ...next } : next);
}

function TextField({ draft, root, field, label, effect, placeholder, mono, disabled }: FieldProps & { placeholder?: string; mono?: boolean }) {
	const id = useId();
	const raw = obj(draft.get([root]))[field];
	return (
		<SettingRow
			label={label}
			effect={effect}
			htmlFor={id}
			refusals={draft.refusedAt([root, field])}
			control={
				<Input
					id={id}
					aria-label={label}
					value={typeof raw === "string" ? raw : ""}
					placeholder={placeholder}
					disabled={disabled}
					className={mono ? "font-mono" : undefined}
					onChange={(e) => setKey(draft, root, field, e.target.value.trim() === "" ? undefined : e.target.value)}
				/>
			}
		/>
	);
}

function NumberField({ draft, root, field, label, effect, placeholder, disabled }: FieldProps & { placeholder?: string }) {
	const id = useId();
	const raw = obj(draft.get([root]))[field];
	return (
		<SettingRow
			label={label}
			effect={effect}
			htmlFor={id}
			refusals={draft.refusedAt([root, field])}
			control={
				<Input
					id={id}
					aria-label={label}
					type="number"
					className="sm:max-w-40"
					value={typeof raw === "number" ? String(raw) : ""}
					placeholder={placeholder}
					disabled={disabled}
					onChange={(e) => {
						const v = e.target.value.trim();
						setKey(draft, root, field, v === "" ? undefined : Number(v));
					}}
				/>
			}
		/>
	);
}

/** "a, b" ↔ ["a", "b"]; blanks and repeats dropped, emptied removes the key. Committed on blur so a comma can be typed. */
function ListField({ draft, root, field, label, effect, placeholder, disabled }: FieldProps & { placeholder?: string }) {
	const id = useId();
	const raw = obj(draft.get([root]))[field];
	const text = Array.isArray(raw) ? raw.map(String).join(", ") : "";
	return (
		<SettingRow
			label={label}
			effect={effect}
			htmlFor={id}
			refusals={draft.refusedAt([root, field])}
			control={
				<Input
					id={id}
					key={text}
					aria-label={label}
					defaultValue={text}
					placeholder={placeholder}
					disabled={disabled}
					className="font-mono"
					onBlur={(e) => {
						const next = [...new Set(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))];
						if (next.join(", ") === text) return;
						// `paths` may be empty and stay; every other list is removed when emptied
						setKey(draft, root, field, next.length === 0 && field !== "paths" ? undefined : next);
					}}
				/>
			}
		/>
	);
}

interface FieldProps {
	draft: DocumentDraft;
	root: "preview" | "fastLane";
	field: string;
	label: string;
	effect?: string;
	disabled: boolean;
}

export function PreviewSection({ projectId, slug, canEdit }: { projectId: string; slug: string; canEdit: boolean }) {
	const t = useCopy();
	const draft = useProjectDraft(projectId);
	const section = sectionOf([draft]);
	if (draft.loading || !draft.ready) return <Skeleton className="h-64 w-full rounded-md" />;
	const off = !canEdit || !draft.declared;
	const idle = PREVIEW_LIMITS.idleMinutes;
	const area = (field: "kernel" | "migrations" | "permissions" | "security", label: string) => (
		<ListField draft={draft} root="fastLane" field={field} label={label} effect={t("previews.settings.fastAreaEffect")} disabled={off} />
	);
	return (
		<div data-testid="preview-section">
			{!draft.declared && <UndeclaredNotice slug={slug} />}
			<SettingGroup id="preview" title={t("previews.settings.previewTitle")} lead={t("previews.settings.previewLead")}>
				<TextField draft={draft} root="preview" field="command" label={t("previews.settings.command")} effect={t("previews.settings.commandEffect")} placeholder={t("previews.settings.commandPlaceholder")} mono disabled={off} />
				<NumberField draft={draft} root="preview" field="port" label={t("previews.settings.port")} effect={t("previews.settings.portEffect")} disabled={off} />
				<TextField draft={draft} root="preview" field="cwd" label={t("previews.settings.cwd")} effect={t("previews.settings.cwdEffect")} mono disabled={off} />
				<NumberField
					draft={draft}
					root="preview"
					field="idleMinutes"
					label={t("previews.settings.idle")}
					effect={t("previews.settings.idleEffect", { min: idle.min, max: idle.max, default: idle.default })}
					placeholder={String(idle.default)}
					disabled={off}
				/>
				<TextField draft={draft} root="preview" field="environment" label={t("previews.settings.environment")} effect={t("previews.settings.environmentEffect")} mono disabled={off} />
			</SettingGroup>
			<SettingGroup id="fast-lane" title={t("previews.settings.fastTitle")} lead={t("previews.settings.fastLead")}>
				<ListField draft={draft} root="fastLane" field="paths" label={t("previews.settings.fastPaths")} effect={t("previews.settings.fastPathsEffect")} placeholder={t("previews.settings.listPlaceholder")} disabled={off} />
				<ListField draft={draft} root="fastLane" field="deployTargets" label={t("previews.settings.fastTargets")} effect={t("previews.settings.fastTargetsEffect")} disabled={off} />
				{area("kernel", t("previews.settings.fastKernel"))}
				{area("migrations", t("previews.settings.fastMigrations"))}
				{area("permissions", t("previews.settings.fastPermissions"))}
				{area("security", t("previews.settings.fastSecurity"))}
			</SettingGroup>
			{draft.declared && <SaveBar section={section} canEdit={canEdit} />}
		</div>
	);
}
