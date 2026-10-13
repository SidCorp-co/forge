"use client";

import {
	Button,
	CardTitle,
	Input,
	type SettingsForm,
	Toggle,
} from "@/design";
import { useRunAssistantWeekly } from "../hooks";
import type { PipelineDraft } from "../pipeline-form";

export function AssistantWeeklySection({
	projectId,
	form,
	canEdit,
	savedEnabled,
}: {
	projectId: string;
	form: SettingsForm<PipelineDraft>;
	canEdit: boolean;
	/** Whether the stored configuration has the reading on, which is what "run now" would run. */
	savedEnabled: boolean;
}) {
	const runNow = useRunAssistantWeekly(projectId);
	const slice = form.draft.assistantWeekly;
	const set = (next: Partial<PipelineDraft["assistantWeekly"]>) =>
		form.setDraft((d) => ({ ...d, assistantWeekly: { ...d.assistantWeekly, ...next } }));
	const incomplete = form.errorAt("assistantWeekly.enabled");

	const field = (
		key: "pinnedIssue" | "judgeProviderId" | "judgeModel" | "source",
		label: string,
		placeholder: string,
	) => (
		<div className="flex items-center gap-3">
			<Input
				id={`assistant-weekly-${key}`}
				type="text"
				value={slice[key] ?? ""}
				disabled={!canEdit || !slice.enabled}
				placeholder={placeholder}
				className="w-64"
				onChange={(e) => set({ [key]: e.target.value })}
			/>
			<label className="fg-body-sm text-fg" htmlFor={`assistant-weekly-${key}`}>
				{label}
			</label>
		</div>
	);

	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Assistant weekly reading</CardTitle>
			<p className="fg-body-sm mb-3 text-muted">
				Once a week, from <strong>Monday 04:00 UTC</strong>, the core grades the
				previous week&apos;s assistant conversations, has the judge model read the
				newest forty, compares them with the week before, and posts one report with
				its files on the pinned issue below. A week that fails is tried again each
				day until its report is on the issue. The benchmark&apos;s own rooms are
				excluded. Nothing else is written.
			</p>

			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-3">
					<Toggle
						checked={slice.enabled}
						onChange={(enabled) => set({ enabled })}
						disabled={!canEdit}
						aria-label="Post a weekly assistant reading"
					/>
					<span className="fg-body-sm text-fg">Post a weekly assistant reading</span>
				</div>
				{field("pinnedIssue", "pinned issue key the series is posted on", "ISS-1060")}
				{field(
					"judgeProviderId",
					"judge provider id (one the app registered)",
					"litellm",
				)}
				{field("judgeModel", "judge model (never the model under test)", "cx/gpt-6-astra")}
				{field("source", "one door only (optional)", "web")}
				{incomplete && (
					<p role="alert" className="fg-caption text-[var(--red-600)]">
						{incomplete}
					</p>
				)}
			</div>

			{canEdit && (
				<div className="mt-3">
					<Button
						variant="secondary"
						loading={runNow.isPending}
						disabled={form.dirty || !savedEnabled || runNow.isPending}
						onClick={() => runNow.mutate()}
						className="min-h-11"
						title="Runs the saved config for the previous ISO week now; a week whose report is already on the issue is skipped"
					>
						Run the reading now
					</Button>
				</div>
			)}
		</div>
	);
}
