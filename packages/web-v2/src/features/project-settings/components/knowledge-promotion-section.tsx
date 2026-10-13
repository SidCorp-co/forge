"use client";

import { CardTitle, type SettingsForm, Toggle } from "@/design";
import type { PipelineDraft } from "../pipeline-form";

export function KnowledgePromotionSection({
	form,
	canEdit,
}: {
	form: SettingsForm<PipelineDraft>;
	canEdit: boolean;
}) {
	const { enabled, candidatesPerRun, minRetrievals } = form.draft.knowledgePromotion;
	const set = (next: Partial<PipelineDraft["knowledgePromotion"]>) =>
		form.setDraft((d) => ({
			...d,
			knowledgePromotion: { ...d.knowledgePromotion, ...next },
		}));
	const perRunError = form.errorAt("knowledgePromotion.candidatesPerRun");
	const retrievalsError = form.errorAt("knowledgePromotion.minRetrievals");

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
						onChange={(next) => set({ enabled: next })}
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
						value={candidatesPerRun}
						disabled={!canEdit || !enabled}
						aria-label="Proposals per night"
						aria-invalid={perRunError ? true : undefined}
						className="h-9 w-20 rounded border border-line bg-surface px-2 text-fg"
						onChange={(e) => set({ candidatesPerRun: Number(e.target.value) })}
					/>
					<span className="fg-body-sm text-fg">
						proposals per night <span className="text-muted">(max 10)</span>
					</span>
				</label>
				{perRunError && (
					<p role="alert" className="fg-caption text-[var(--red-600)]">
						{perRunError}
					</p>
				)}
				<label className="flex items-center gap-3">
					<input
						type="number"
						min={1}
						max={100}
						value={minRetrievals}
						disabled={!canEdit || !enabled}
						aria-label="Minimum retrievals before a memory is eligible"
						aria-invalid={retrievalsError ? true : undefined}
						className="h-9 w-20 rounded border border-line bg-surface px-2 text-fg"
						onChange={(e) => set({ minRetrievals: Number(e.target.value) })}
					/>
					<span className="fg-body-sm text-fg">
						retrievals before a memory is eligible{" "}
						<span className="text-muted">(higher = fewer, better proposals)</span>
					</span>
				</label>
				{retrievalsError && (
					<p role="alert" className="fg-caption text-[var(--red-600)]">
						{retrievalsError}
					</p>
				)}
			</div>
		</div>
	);
}
