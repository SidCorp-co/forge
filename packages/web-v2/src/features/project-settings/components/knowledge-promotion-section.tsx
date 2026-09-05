"use client";

// cm:edge contract -> packages/core/src/memory/consolidation.ts — `resolveKnowledgePromotion` is the only reader of what this writes, and it runs inside the nightly `memory-consolidation` job; a field renamed on one side arrives as undefined on the other with no error anywhere
// cm:guard round-trip the WHOLE fetched config and edit only this slice (`...config`) — PATCH /pipeline-config merges shallowly, so a partial object drops every sibling key the operator set elsewhere on this page

import { useEffect, useState } from "react";
import { Banner, Button, Toggle } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import type { PipelineConfig } from "../types";

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
		const next: PipelineConfig = {
			...config,
			knowledgePromotion: { enabled, candidatesPerRun: perRun, minRetrievals },
		};
		update.mutate(next);
	}

	return (
		<div className="mt-6 border-t border-line pt-5">
			<h3 className="fg-label text-fg">Knowledge promotion</h3>
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
						<Banner tone="danger" onDismiss={() => update.reset()}>
							{formatPipelineConfigError(update.error)}
						</Banner>
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
