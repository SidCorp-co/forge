"use client";

// Project settings → Pipeline → "Master backlog" (ISS-917).
//
// Sets `pipelineConfig.poolBacklog` — the statuses whose issues a master agent
// SEES beside the claimable pool. Visible only: a backlog row carries no job
// and cannot be claimed, and turning one into work is an explicit
// `forge-runner pool promote`, which re-checks the entry gate first.

import { REGISTRY_BACKLOG_ADMISSIBLE_STATUSES } from "@forge/contracts/pipeline-registry";
import {
  Banner,
  CardTitle,
  Checkbox,
  type SettingsForm,
  Toggle,
} from "@/design";
import { statusLabel } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import type { PipelineDraft } from "../pipeline-form";

const ADMISSIBLE = [...REGISTRY_BACKLOG_ADMISSIBLE_STATUSES] as IssueStatus[];

export function PoolBacklogSection({
	form,
	canEdit,
}: {
	form: SettingsForm<PipelineDraft>;
	canEdit: boolean;
}) {
	const { statuses, limit } = form.draft.poolBacklog;
	const set = (next: Partial<PipelineDraft["poolBacklog"]>) =>
		form.setDraft((d) => ({ ...d, poolBacklog: { ...d.poolBacklog, ...next } }));
	const enabled = statuses.length > 0;
	const conflict = form.errorAt("poolBacklog.statuses");
	const limitError = form.errorAt("poolBacklog.limit");

	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Master backlog</CardTitle>
			<p className="fg-body-sm mb-1 text-muted">
				A master agent normally sees only work the pipeline has already queued.
				Admit a status here and its issues also show up as a{" "}
				<strong>backlog</strong> — visible and readable, so the master can
				decide whether any of them is worth pulling up now.
			</p>
			<p className="fg-body-sm mb-3 text-muted">
				<strong>Admitting a status does not make it run.</strong> A backlog
				issue has no job and cannot be claimed. A master turns one into work
				with an explicit promote, which goes through the same{" "}
				<em>Start queued issues automatically</em> gate as everything else — so
				if that is off, nothing here can start either.
			</p>

			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-3">
					<Toggle
						checked={enabled}
						onChange={(on) => set({ statuses: on ? ["draft"] : [] })}
						disabled={!canEdit}
						aria-label="Show a backlog to this project's master agents"
					/>
					<span className="fg-body-sm text-fg">
						Show a backlog to this project&rsquo;s master agents
					</span>
				</div>

				{enabled && (
					<>
						<fieldset className="flex flex-wrap gap-x-5 gap-y-2 border-0 p-0">
							<legend className="fg-caption mb-1 text-muted">
								Statuses admitted to the backlog
							</legend>
							{ADMISSIBLE.map((s) => (
								<Checkbox
									key={s}
									checked={statuses.includes(s)}
									onChange={(on) =>
										set({
											statuses: on
												? [...statuses, s]
												: statuses.filter((x) => x !== s),
										})
									}
									disabled={!canEdit}
									label={
										<span className="fg-body-sm text-fg">{statusLabel(s)}</span>
									}
								/>
							))}
						</fieldset>
						<label className="flex items-center gap-3">
							<input
								type="number"
								min={1}
								max={100}
								value={limit}
								disabled={!canEdit}
								aria-label="Backlog rows a master may read at once"
								aria-invalid={limitError ? true : undefined}
								className="h-9 w-20 rounded border border-line bg-surface px-2 text-fg"
								onChange={(e) => set({ limit: Number(e.target.value) })}
							/>
							<span className="fg-body-sm text-fg">
								rows a master may read at once{" "}
								<span className="text-muted">(max 100)</span>
							</span>
						</label>
						{limitError && (
							<p role="alert" className="fg-caption text-[var(--red-600)]">
								{limitError}
							</p>
						)}
					</>
				)}
			</div>

			{conflict && (
				<div className="mt-3">
					<Banner tone="attention">{conflict}</Banner>
				</div>
			)}
		</div>
	);
}
