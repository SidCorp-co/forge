"use client";

// Project settings → Pipeline → "Master backlog" (ISS-917).
//
// Sets `pipelineConfig.poolBacklog` — the statuses whose issues a master agent
// SEES beside the claimable pool. Visible only: a backlog row carries no job
// and cannot be claimed, and turning one into work is an explicit
// `forge-runner pool promote`, which re-checks the entry gate first.
//
// Save-island contract mirrors intake-gate-section.tsx: take the full fetched
// config, edit only this slice, spread `...config` so sibling keys survive the
// shallow PATCH merge.

import { REGISTRY_BACKLOG_ADMISSIBLE_STATUSES } from "@forge/contracts/pipeline-registry";
import {
  Banner,
  Button,
  CardTitle,
  Checkbox,
  Toggle,
} from "@/design";
import { statusLabel } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { useSettingsDraft } from "../draft";
import { useUpdatePipelineConfig } from "../hooks";
import { type PipelineConfig, sectionWrite } from "../types";
import { SaveRefusedBanner } from "./save-refused-banner";

const DEFAULT_LIMIT = 20;

const ADMISSIBLE = [...REGISTRY_BACKLOG_ADMISSIBLE_STATUSES] as IssueStatus[];

const AT = ["poolBacklog"] as const;

interface Slice {
	statuses: string[];
	limit: number;
}

const seed = (config: PipelineConfig): Slice => ({
	statuses: config.poolBacklog?.statuses ?? [],
	limit: config.poolBacklog?.limit ?? DEFAULT_LIMIT,
});

export function PoolBacklogSection({
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

	const held = useSettingsDraft(seed(config), { at: AT });
	const { statuses, limit } = held.draft;
	const dirty = held.dirty;
	const setLimit = (next: number) => held.setDraft((d) => ({ ...d, limit: next }));

	const enabled = statuses.length > 0;
	const intakeGateOn = config.intakeGate?.enabled === true;
	const conflict = intakeGateOn && statuses.includes("draft");

	function toggleStatus(status: string, on: boolean) {
		held.setDraft((d) => ({
			...d,
			statuses: on ? [...d.statuses, status] : d.statuses.filter((s) => s !== status),
		}));
	}

	function save() {
		update.mutate(
			sectionWrite(
				{ poolBacklog: config.poolBacklog },
				{ poolBacklog: statuses.length === 0 ? undefined : { statuses, limit } },
			),
		);
	}

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
						onChange={(on) =>
							held.setDraft((d) => ({ ...d, statuses: on ? ["draft"] : [] }))
						}
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
									onChange={(on) => toggleStatus(s, on)}
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
								className="h-9 w-20 rounded border border-line bg-surface px-2 text-fg"
								onChange={(e) => setLimit(Number(e.target.value))}
							/>
							<span className="fg-body-sm text-fg">
								rows a master may read at once{" "}
								<span className="text-muted">(max 100)</span>
							</span>
						</label>
					</>
				)}
			</div>

			{conflict && (
				<div className="mt-3">
					<Banner tone="attention">
						Intake gate is on, which parks every new issue at Draft for a human
						to approve. A master that may promote drafts is that human, so Draft
						can&rsquo;t also be admitted here — turn the intake gate off, or
						drop Draft from this list.
					</Banner>
				</div>
			)}

			{canEdit && (
				<div className="mt-3 space-y-3">
					<SaveRefusedBanner
						projectId={projectId}
						error={update.isError ? update.error : null}
						onDismiss={() => update.reset()}
						draft={held}
					/>
					{update.isSuccess && !dirty && (
						<Banner tone="success" onDismiss={() => update.reset()}>
							Master backlog saved.
						</Banner>
					)}
					<Button
						variant="primary"
						loading={update.isPending}
						disabled={!dirty || update.isPending || conflict}
						onClick={save}
						className="min-h-11"
					>
						Save master backlog
					</Button>
				</div>
			)}
		</div>
	);
}
