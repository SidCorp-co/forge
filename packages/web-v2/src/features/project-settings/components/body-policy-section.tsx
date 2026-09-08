"use client";

// Project settings → Pipeline → "Typed comment bodies" (ISS-969).
//
// Two things in one place on purpose: the number a mandate is decided from,
// and the switch that raises it. `docs/proposals/body-templates.md` says a
// stage goes to required only against its own adoption figure, and a screen
// that offers the switch without the figure is how that rule gets skipped.
//
// Sets `pipelineConfig.states[stage].bodyPolicy`. Save-island contract mirrors
// pool-backlog-section.tsx: take the full fetched config, edit only this slice,
// spread `...config` so sibling keys survive the shallow PATCH merge.

import { useEffect, useState } from "react";
import {
	Banner,
	Button,
	ErrorState,
	NativeSelect,
	Skeleton,
} from "@/design";
import { bodyApi } from "@/features/issues/body-api";
import { statusLabel } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { formatApiError } from "@/lib/api/error";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useQuery } from "@tanstack/react-query";
import { useBodyAdoption, useUpdatePipelineConfig } from "../hooks";
import type { PipelineConfig, PipelineStateConfig, StageAdoption } from "../types";

// cm:edge contract -> packages/core/src/pipeline/pipeline-config-schema.ts#STAGE_NAMES — the same four names core keys `states` by, and a stage drawn here that core does not accept saves as a zod refusal naming a path rather than a stage
const STAGES = ["open", "in_progress", "needs_info", "released"] as const;

const WINDOW_DAYS = 14;

/** No component required — the value every stage starts at and returns to. */
const NONE = "";

/** What each stage requires according to the SERVER document, as the select reads it. */
function seedFrom(config: PipelineConfig): Record<string, string> {
	return Object.fromEntries(
		STAGES.map((stage) => [
			stage,
			(config.states?.[stage] as PipelineStateConfig | undefined)?.bodyPolicy
				?.requireComponent ?? NONE,
		]),
	);
}

function fractionLabel(row: StageAdoption): string {
	if (row.total === 0) return "no agent comments in the window";
	const typed = Object.values(row.byComponent).reduce((n, v) => n + v, 0);
	const pct = Math.round((typed / row.total) * 100);
	return `${typed} of ${row.total} carry a component (${pct}%)`;
}

function requiredLabel(row: StageAdoption): string | null {
	if (!row.requireComponent) return null;
	if (row.total === 0)
		return `requires ${row.requireComponent} — nothing written yet`;
	const pct = Math.round((row.fractionRequired ?? 0) * 100);
	return `${row.carryingRequired} of ${row.total} carry ${row.requireComponent} (${pct}%)`;
}

export function BodyPolicySection({
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
	const adoption = useBodyAdoption(projectId, WINDOW_DAYS);
	// cm:why the root names come over the wire rather than from a list here: core's registry is internal by `body/public.ts`'s ISS-898 guard, and a second component list in web is exactly the drift `/api/body/components` was added to prevent
	const components = useQuery({
		queryKey: ["body-components"],
		queryFn: () => bodyApi.components(),
		staleTime: 5 * 60_000,
	});

	const seeded = seedFrom(config);
	const [required, setRequired] = useState<Record<string, string>>(seeded);
	useEffect(() => setRequired(seedFrom(config)), [config]);

	const dirty = STAGES.some((s) => (required[s] ?? NONE) !== (seeded[s] ?? NONE));
	const roots = (components.data ?? []).filter((c) => c.root).map((c) => c.name);

	// cm:guard clearing a stage must DELETE the key, never store `{ requireComponent: "" }`. Absent is the documented off state every other project is in, and an empty object is a second spelling of it that reads as "configured" on the next screen that looks — and core's `z.enum` refuses the empty string anyway, so the save would 400.
	function save() {
		const next: PipelineConfig = { ...config };
		const states: Record<string, PipelineStateConfig | undefined> = {
			...(next.states ?? {}),
		};
		for (const stage of STAGES) {
			const want = required[stage] ?? NONE;
			const current = { ...((states[stage] ?? {}) as PipelineStateConfig) };
			if (want === NONE) delete current.bodyPolicy;
			else current.bodyPolicy = { requireComponent: want };
			if (Object.keys(current).length > 0) states[stage] = current;
			else delete states[stage];
		}
		next.states = states;
		update.mutate(next);
	}

	const byStage = new Map((adoption.data?.stages ?? []).map((r) => [r.stage, r]));

	return (
		<div className="mt-6 border-t border-line pt-5">
			<h3 className="fg-label text-fg">Typed comment bodies</h3>
			<p className="fg-body-sm mb-1 text-muted">
				Agents can write a comment as a typed component &mdash;{" "}
				<code>&lt;forge-outcome&gt;</code>, <code>&lt;forge-review&gt;</code>{" "}
				&mdash; instead of prose. Require one at a stage and a comment written
				there without it is refused, naming the component and the stage.
			</p>
			<p className="fg-body-sm mb-3 text-muted">
				<strong>Read the number before you require anything.</strong> Nothing is
				required anywhere until you set it here, and a stage with low adoption
				will start refusing writes the moment you do. People writing prose are
				never refused.
			</p>

			{adoption.isPending && (
				<div className="flex flex-col gap-2" aria-hidden="true">
					{STAGES.map((s) => (
						<Skeleton key={s} className="h-14 w-full" />
					))}
				</div>
			)}

			{adoption.isError && (
				<ErrorState
					mascot={false}
					title="Couldn't read adoption"
					message={formatApiError(adoption.error)}
					onRetry={() => adoption.refetch()}
				/>
			)}

			{adoption.isSuccess && (
				<div className="flex flex-col gap-3">
					<p className="fg-caption text-muted">
						Last {adoption.data.windowDays} days, agent-written comments only.
					</p>
					{STAGES.map((stage) => {
						const row = byStage.get(stage);
						const value = required[stage] ?? NONE;
						return (
							<div
								key={stage}
								className="flex flex-col gap-2 rounded border border-line p-3 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0 sm:flex-1">
									<p className="fg-body-sm text-fg">
										{statusLabel(stage as IssueStatus)}
									</p>
									<p className="fg-caption text-muted">
										{row ? fractionLabel(row) : "no data"}
									</p>
									{row && requiredLabel(row) && (
										<p className="fg-caption text-muted">
											{requiredLabel(row)}
										</p>
									)}
								</div>
								<div className="sm:w-64 sm:shrink-0">
								<NativeSelect
									value={value}
									disabled={!canEdit || components.isPending}
									aria-label={`Component required at ${statusLabel(stage as IssueStatus)}`}
									onChange={(e) =>
										setRequired((prev) => ({ ...prev, [stage]: e.target.value }))
									}
									options={[
										{ value: NONE, label: "Nothing required" },
										...roots.map((name) => ({ value: name, label: name })),
									]}
								/>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{components.isError && (
				<div className="mt-3">
					<Banner tone="attention">
						Couldn&rsquo;t load the component list, so the picker is empty. The
						numbers above are still current.
					</Banner>
				</div>
			)}

			{canEdit && (
				<div className="mt-3 space-y-3">
					{update.isError && (
						<Banner tone="danger" onDismiss={() => update.reset()}>
							{formatPipelineConfigError(update.error)}
						</Banner>
					)}
					<Button
						variant="primary"
						loading={update.isPending}
						disabled={!dirty || update.isPending}
						onClick={save}
						className="min-h-11"
					>
						Save body policy
					</Button>
				</div>
			)}
		</div>
	);
}
