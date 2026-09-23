"use client";


import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  CardTitle,
  Toggle,
} from "@/design";
import { useUpdatePipelineConfig } from "../hooks";
import { type PipelineConfig, sectionWrite } from "../types";
import { SaveRefusedBanner } from "./save-refused-banner";

const DEFAULT_PER_RUN = 3;
const DEFAULT_MIN_RETRIEVALS = 3;

export function KnowledgePromotionSection({
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

	const seededEnabled = config.knowledgePromotion?.enabled ?? false;
	const seededPerRun = config.knowledgePromotion?.candidatesPerRun ?? DEFAULT_PER_RUN;
	const seededMin = config.knowledgePromotion?.minRetrievals ?? DEFAULT_MIN_RETRIEVALS;
	const [enabled, setEnabled] = useState(seededEnabled);
	const [perRun, setPerRun] = useState(seededPerRun);
	const [minRetrievals, setMinRetrievals] = useState(seededMin);
	useEffect(() => {
		setEnabled(config.knowledgePromotion?.enabled ?? false);
		setPerRun(config.knowledgePromotion?.candidatesPerRun ?? DEFAULT_PER_RUN);
		setMinRetrievals(config.knowledgePromotion?.minRetrievals ?? DEFAULT_MIN_RETRIEVALS);
	}, [config]);

	const dirty =
		enabled !== seededEnabled || perRun !== seededPerRun || minRetrievals !== seededMin;

	function save() {
		update.mutate(
			sectionWrite(
				{ knowledgePromotion: config.knowledgePromotion },
				{ knowledgePromotion: { enabled, candidatesPerRun: perRun, minRetrievals } },
			),
		);
	}

	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Knowledge promotion</CardTitle>
			<p className="fg-body-sm mb-3 text-muted">
				Every night at <strong>03:00 UTC</strong> the memory consolidation job
				looks for memories this project has actually re-read, and files each one
				as an <strong>open</strong> issue proposing it for the curated knowledge
				store. Open means the pipeline picks it up — so this costs runner
				capacity at the rate below. Nothing is written to curated knowledge until
				that issue is worked.
			</p>

			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-3">
					<Toggle
						checked={enabled}
						onChange={setEnabled}
						disabled={!canEdit}
						aria-label="Propose durable memories for curated knowledge"
					/>
					<span className="fg-body-sm text-fg">
						Propose durable memories for curated knowledge
					</span>
				</div>

				<label className="flex items-center gap-3">
					<input
						type="number"
						min={1}
						max={10}
						value={perRun}
						disabled={!canEdit || !enabled}
						aria-label="Proposals per night"
						className="h-9 w-20 rounded border border-line bg-surface px-2 text-fg"
						onChange={(e) => setPerRun(Number(e.target.value))}
					/>
					<span className="fg-body-sm text-fg">
						proposals per night <span className="text-muted">(max 10)</span>
					</span>
				</label>

				<label className="flex items-center gap-3">
					<input
						type="number"
						min={1}
						max={100}
						value={minRetrievals}
						disabled={!canEdit || !enabled}
						aria-label="Minimum retrievals before a memory is eligible"
						className="h-9 w-20 rounded border border-line bg-surface px-2 text-fg"
						onChange={(e) => setMinRetrievals(Number(e.target.value))}
					/>
					<span className="fg-body-sm text-fg">
						retrievals before a memory is eligible{" "}
						<span className="text-muted">(higher = fewer, better proposals)</span>
					</span>
				</label>
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
							Knowledge promotion saved.
						</Banner>
					)}
					<Button
						variant="primary"
						loading={update.isPending}
						disabled={!dirty || update.isPending}
						onClick={save}
						className="min-h-11"
					>
						Save knowledge promotion
					</Button>
				</div>
			)}
		</div>
	);
}
