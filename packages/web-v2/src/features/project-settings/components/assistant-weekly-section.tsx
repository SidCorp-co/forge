"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  CardTitle,
  Toggle,
	Input,
} from "@/design";
import { useRunAssistantWeekly, useUpdatePipelineConfig } from "../hooks";
import { type PipelineConfig, sectionWrite } from "../types";
import { SaveRefusedBanner } from "./save-refused-banner";

type Slice = NonNullable<PipelineConfig["assistantWeekly"]>;

const EMPTY: Slice = { enabled: false, pinnedIssue: "", judgeProviderId: "", judgeModel: "" };

const seed = (config: PipelineConfig): Slice => ({ ...EMPTY, ...(config.assistantWeekly ?? {}) });

export function AssistantWeeklySection({
	projectId,
	config,
	canEdit,
}: {
	projectId: string;
	/** The full server-fetched pipelineConfig (round-tripped on save). */
	config: PipelineConfig;
	canEdit: boolean;
}) {
	const update = useUpdatePipelineConfig(projectId);
	const runNow = useRunAssistantWeekly(projectId);
	const seeded = seed(config);
	const [slice, setSlice] = useState<Slice>(seeded);
	useEffect(() => {
		setSlice(seed(config));
	}, [config]);

	const dirty = JSON.stringify(slice) !== JSON.stringify(seeded);
	const complete =
		!slice.enabled ||
		(slice.pinnedIssue.trim() !== "" &&
			slice.judgeProviderId.trim() !== "" &&
			slice.judgeModel.trim() !== "");

	function save() {
		const source = slice.source?.trim();
		update.mutate(
			sectionWrite(
				{ assistantWeekly: config.assistantWeekly },
				{
					assistantWeekly: {
						enabled: slice.enabled,
						pinnedIssue: slice.pinnedIssue.trim(),
						judgeProviderId: slice.judgeProviderId.trim(),
						judgeModel: slice.judgeModel.trim(),
						...(source ? { source } : {}),
					},
				},
			),
		);
	}

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
				onChange={(e) => setSlice({ ...slice, [key]: e.target.value })}
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
						onChange={(enabled) => setSlice({ ...slice, enabled })}
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
			</div>

			{canEdit && (
				<div className="mt-3 space-y-3">
					{update.isError && (
						<SaveRefusedBanner
							projectId={projectId}
							error={update.error}
							onDismiss={() => update.reset()}
						/>
					)}
					{update.isSuccess && !dirty && (
						<Banner tone="success" onDismiss={() => update.reset()}>
							Assistant weekly reading saved.
						</Banner>
					)}
					<div className="flex flex-wrap gap-3">
						<Button
							variant="primary"
							loading={update.isPending}
							disabled={!dirty || !complete || update.isPending}
							onClick={save}
							className="min-h-11"
						>
							Save assistant weekly reading
						</Button>
						<Button
							variant="secondary"
							loading={runNow.isPending}
							disabled={dirty || !seeded.enabled || runNow.isPending}
							onClick={() => runNow.mutate()}
							className="min-h-11"
							title="Runs the saved config for the previous ISO week now; a week whose report is already on the issue is skipped"
						>
							Run the reading now
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
