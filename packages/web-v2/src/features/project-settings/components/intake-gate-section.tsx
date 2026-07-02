"use client";

// Project settings → Pipeline → "Intake gate" (ISS-606).
//
// Sets `pipelineConfig.intakeGate` — when enabled, EVERY new issue that would
// land at `open` (public webhook, REST, MCP, member-created included) parks at
// `draft` with the `intake` label until a human approves it into the pipeline
// via the existing draft→open transition. Review queue = issues list filtered
// to status draft + label intake.
//
// Save-island contract mirrors concurrency-section.tsx: take the full fetched
// config, edit only this slice, spread `...config` so sibling keys survive the
// shallow PATCH merge.

import { useEffect, useState } from "react";
import { Banner, Button, Toggle } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import type { PipelineConfig } from "../types";

export function IntakeGateSection({
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

	const seededEnabled = config.intakeGate?.enabled ?? false;
	const seededNotify = config.intakeGate?.notify !== false;
	const [enabled, setEnabled] = useState(seededEnabled);
	const [notify, setNotify] = useState(seededNotify);
	useEffect(() => {
		setEnabled(config.intakeGate?.enabled ?? false);
		setNotify(config.intakeGate?.notify !== false);
	}, [config]);

	const dirty = enabled !== seededEnabled || notify !== seededNotify;

	function save() {
		const next: PipelineConfig = {
			...config,
			intakeGate: { enabled, notify },
		};
		update.mutate(next);
	}

	return (
		<div className="mt-6 border-t border-line pt-5">
			<h3 className="fg-label text-fg">Intake gate</h3>
			<p className="fg-body-sm mb-3 text-muted">
				When on, <strong>every</strong> new issue — from public webhooks, the
				API, or members — parks as a <strong>draft</strong> with the{" "}
				<code className="font-mono text-[12px]">intake</code> label instead of
				entering the pipeline. Approve by moving it{" "}
				<code className="font-mono text-[12px]">draft → open</code>; reject by
				closing it. Review queue: the issues list filtered to draft +{" "}
				<code className="font-mono text-[12px]">intake</code>.
			</p>

			<div className="flex flex-col gap-3">
				<label className="flex items-center gap-3">
					<Toggle
						checked={enabled}
						onChange={setEnabled}
						disabled={!canEdit}
						aria-label="Require human approval for new issues"
					/>
					<span className="fg-body-sm text-fg">
						Require human approval for new issues
					</span>
				</label>
				<label className="flex items-center gap-3">
					<Toggle
						checked={notify}
						onChange={setNotify}
						disabled={!canEdit || !enabled}
						aria-label="Notify the project owner on each gated issue"
					/>
					<span className="fg-body-sm text-fg">
						Notify the project owner on each gated issue
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
							Intake gate saved.
						</Banner>
					)}
					<Button
						variant="primary"
						loading={update.isPending}
						disabled={!dirty || update.isPending}
						onClick={save}
						className="min-h-11"
					>
						Save intake gate
					</Button>
				</div>
			)}
		</div>
	);
}
