"use client";

// The pieces every settings section is built from: a group heading, a field bound to one place in a
// document the section holds, and the one save bar a section has.
import { type ComponentProps, type ReactNode, useId } from "react";
import { Button, Input, NativeSelect, type SelectOption, SettingRow, Textarea, Toggle } from "@/design";
import { cn } from "@/lib/utils/cn";
import type { DocumentDraft, sectionOf } from "@/features/project-config";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatApiError } from "@/lib/api/error";
import { readRefusal, type Refusal } from "@/lib/api/refusals";

/** A section's heading: the primary colour, a clear step above its fields (fg-h3 sets its own colour, so this one wins). */
export const SETTINGS_HEADING = "fg-h3 text-accent-text!";

/** A native picker as wide as `width` says, its chevron at its own edge rather than the column's. */
export function Picker({ width, ...props }: ComponentProps<typeof NativeSelect> & { width?: string }) {
	return (
		<div className={cn("w-full", width)}>
			<NativeSelect {...props} />
		</div>
	);
}

const refusalText = (refusals: readonly Refusal[]) =>
	refusals.map((r) => `${readRefusal(r).code}: ${readRefusal(r).sentence}`).join(" · ");

/** Core's refusals at one field, as the line SettingRow shows in its hint's place. */
export const refusalError = (refusals: readonly Refusal[]) => (refusals.length > 0 ? refusalText(refusals) : undefined);

interface Bound {
	draft: DocumentDraft;
	path: readonly string[];
	label: string;
	effect?: ReactNode;
	disabled?: boolean;
}

/** Text at `path`; emptied, the key is removed (`optional`) or kept as the empty string. */
export function TextSetting({
	draft,
	path,
	label,
	effect,
	disabled,
	placeholder,
	optional,
	multiline,
	mono,
}: Bound & { placeholder?: string; optional?: boolean; multiline?: boolean; mono?: boolean }) {
	const id = useId();
	const value = draft.get(path);
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
	const onChange = (next: string) => draft.set(path, optional && next.trim() === "" ? undefined : next);
	return (
		<SettingRow
			label={label}
			hint={effect}
			htmlFor={id}
			error={refusalError(draft.refusedAt(path))}
			control={
				multiline ? (
					<Textarea id={id} aria-label={label} value={text} rows={4} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
				) : (
					<Input
						id={id}
						aria-label={label}
						value={text}
						disabled={disabled}
						placeholder={placeholder}
						className={mono ? "font-mono" : undefined}
						onChange={(e) => onChange(e.target.value)}
					/>
				)
			}
		/>
	);
}

/** One of `options` at `path`; `unset` is the option that removes the key. */
export function ChoiceSetting({
	draft,
	path,
	label,
	effect,
	disabled,
	options,
	unset,
}: Bound & { options: SelectOption[]; unset?: string }) {
	const id = useId();
	const value = draft.get(path);
	const current = value === undefined ? (unset ?? "") : typeof value === "string" ? value : JSON.stringify(value);
	return (
		<SettingRow
			label={label}
			hint={effect}
			htmlFor={id}
			error={refusalError(draft.refusedAt(path))}
			control={
				<Picker
					id={id}
					aria-label={label}
					value={current}
					disabled={disabled}
					options={options}
					width="sm:max-w-md"
					onChange={(e) => draft.set(path, unset !== undefined && e.target.value === unset ? undefined : e.target.value)}
				/>
			}
		/>
	);
}

/** A yes/no at `path`, read as `fallback` where the document says nothing. */
export function SwitchSetting({ draft, path, label, effect, disabled, fallback }: Bound & { fallback: boolean }) {
	const value = draft.get(path);
	const on = typeof value === "boolean" ? value : fallback;
	return (
		<SettingRow
			inline
			label={label}
			hint={effect}
			error={refusalError(draft.refusedAt(path))}
			control={<Toggle checked={on} disabled={disabled} aria-label={label} onChange={(v) => draft.set(path, v)} />}
		/>
	);
}

type Section = ReturnType<typeof sectionOf>;

/** The section's one save: what is unsaved, what was refused and by which name, and the two ways out. */
export function SaveBar({ section, canEdit }: { section: Section; canEdit: boolean }) {
	const t = useCopy();
	if (!canEdit) return null;
	const refused = section.refusals.length > 0 || section.failures.length > 0;
	// nothing to say while nothing is edited: a bar of faded buttons is noise, not a state
	if (!section.dirty && !section.moved && !refused && !section.saved) return null;
	const state = section.moved
		? t("settings.project.save.moved")
		: refused
			? t("settings.project.save.refused")
			: section.dirty
				? t("settings.project.save.unsaved")
				: section.saved
					? t("settings.project.save.saved")
					: t("settings.project.save.clean");
	return (
		<div
			data-testid="save-bar"
			data-state={section.moved ? "moved" : refused ? "refused" : section.dirty ? "dirty" : "clean"}
			className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-surface px-4 py-3 sm:-mx-8 sm:px-8"
		>
			<div className="flex flex-wrap items-center gap-3">
				<p className="fg-body-sm min-w-0 flex-1 text-fg" role="status">
					{state}
				</p>
				{section.moved ? (
					<>
						<Button variant="secondary" onClick={section.discard} className="min-h-11">
							{t("settings.project.save.reload")}
						</Button>
						<Button variant="primary" onClick={section.reapply} className="min-h-11">
							{t("settings.project.save.reapply")}
						</Button>
					</>
				) : (
					<>
						<Button variant="ghost" disabled={!section.dirty || section.saving} onClick={section.discard} className="min-h-11">
							{t("settings.project.save.discard")}
						</Button>
						<Button variant="primary" disabled={!section.dirty} loading={section.saving} onClick={() => void section.save()} className="min-h-11">
							{t("settings.project.save.save")}
						</Button>
					</>
				)}
			</div>
			{refused && (
				<ul className="fg-caption mt-2 space-y-0.5 text-danger-11">
					{section.refusals.map((r) => (
						<li key={`${r.code}:${r.path}`}>
							<code translate="no">{r.code}</code>
							{r.path ? (
								<>
									{" "}
									<code translate="no">{readRefusal(r).where}</code>
								</>
							) : null}
							: {readRefusal(r).sentence}
						</li>
					))}
					{section.failures.map((f) => (
						<li key={f.message}>{formatApiError(f)}</li>
					))}
				</ul>
			)}
		</div>
	);
}

export const optionsOf = (t: ReturnType<typeof useCopy>, prefix: string, values: readonly string[]): SelectOption[] =>
	values.map((v) => ({ value: v, label: t(`${prefix}.${v}` as Parameters<typeof t>[0]) }));
