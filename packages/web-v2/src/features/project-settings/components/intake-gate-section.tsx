"use client";

// Project settings → Pipeline → "Intake gate" (ISS-606).
//
// Sets `pipelineConfig.intakeGate` — when enabled, EVERY new issue that would
// land at `open` (public webhook, REST, MCP, member-created included) parks at
// `draft` with the `intake` label until a human approves it into the pipeline
// via the existing draft→open transition. Review queue = issues list filtered
// to status draft + label intake. Saved with the rest of the page.

import { CardTitle, type SettingsForm, Toggle } from "@/design";
import type { PipelineDraft } from "../pipeline-form";

export function IntakeGateSection({
	form,
	canEdit,
}: {
	form: SettingsForm<PipelineDraft>;
	canEdit: boolean;
}) {
	const { enabled, notify } = form.draft.intakeGate;
	const set = (next: Partial<PipelineDraft["intakeGate"]>) =>
		form.setDraft((d) => ({ ...d, intakeGate: { ...d.intakeGate, ...next } }));

	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Intake gate</CardTitle>
			<p className="fg-body-sm mb-3 text-muted">
				When on, <strong>every</strong> new issue — from public webhooks, the
				API, or members — parks as a <strong>draft</strong> with the{" "}
				<code className="font-mono text-12">intake</code> label instead of
				entering the pipeline. Approve by moving it{" "}
				<code className="font-mono text-12">draft → open</code>; reject by
				closing it. Review queue: the issues list filtered to draft +{" "}
				<code className="font-mono text-12">intake</code>.
			</p>

			<div className="flex flex-col gap-3">
				<label className="flex items-center gap-3">
					<Toggle
						checked={enabled}
						onChange={(next) => set({ enabled: next })}
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
						onChange={(next) => set({ notify: next })}
						disabled={!canEdit || !enabled}
						aria-label="Notify the project owner on each gated issue"
					/>
					<span className="fg-body-sm text-fg">
						Notify the project owner on each gated issue
					</span>
				</label>
			</div>
		</div>
	);
}
