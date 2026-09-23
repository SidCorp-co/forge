"use client";

// What a refused settings save looks like to the person who made it: WHICH settings changed
// under them, that NOTHING was written, and a way out that makes the save possible (ISS-1170).
//
// Two ways out, because only the person knows which they want: take what is stored now at the
// settings that moved, or keep what they typed and save over it. Both re-read the document, so
// both leave this section writing against what is actually stored, and neither touches an edit
// anywhere else on the page — the sections carry their drafts across a re-read (`../draft.ts`).

import { useQueryClient } from "@tanstack/react-query";
import { Banner, Button } from "@/design";
import {
	formatPipelineConfigError,
	formatSettingsWriteError,
	settingsThatMoved,
	writeConflicts,
} from "@/lib/api/error";
import type { SettingsDraft } from "../draft";

export function SaveRefusedBanner({
	projectId,
	error,
	onDismiss,
	document = "pipeline-config",
	draft,
}: {
	projectId: string;
	/** The refusal, or null where the last save was not refused. */
	error: unknown;
	onDismiss?: () => void;
	/** Which settings document to re-read — the query key whose data seeds this section. */
	document?: "pipeline-config" | "environments";
	/** The draft this section holds. Both ways out act on it, and it is what reports back
	 *  which edits a re-read replaced. */
	// biome-ignore lint/suspicious/noExplicitAny: every section's draft shape, read only through the contract's own paths.
	draft: Pick<SettingsDraft<any>, "takeStored" | "replaced" | "dismissReplaced">;
}) {
	const qc = useQueryClient();
	const conflicts = writeConflicts(error);

	function reread(yielding: string[]) {
		draft.takeStored(yielding);
		qc.invalidateQueries({ queryKey: ["project", projectId, document] });
		onDismiss?.();
	}

	if (draft.replaced.length > 0 && conflicts.length === 0) {
		return (
			<Banner tone="attention" onDismiss={draft.dismissReplaced}>
				Loaded what is stored now. Your changes to{" "}
				{settingsThatMoved(draft.replaced.map((edit) => edit.path))} were replaced by the
				stored values; every other edit on this page is as you left it.
			</Banner>
		);
	}

	if (error === null || error === undefined) return null;

	const moved = settingsThatMoved(conflicts.map((c) => c.path));

	return (
		<Banner tone={conflicts.length > 0 ? "attention" : "danger"} onDismiss={onDismiss}>
			<div className="space-y-2">
				<p>
					{document === "environments"
						? formatSettingsWriteError(error)
						: formatPipelineConfigError(error)}
				</p>
				{conflicts.length > 0 && (
					<>
						<p className="fg-caption text-muted">
							Your edits everywhere else on this page are kept either way.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => reread(conflicts.map((c) => c.path))}
							>
								Use the current values
							</Button>
							<Button variant="secondary" size="sm" onClick={() => reread([])}>
								Keep my changes
							</Button>
						</div>
						<p className="fg-caption text-muted">
							<b>Use the current values</b> replaces what you typed into {moved}.{" "}
							<b>Keep my changes</b> keeps it, and your next save writes over what is stored
							now — or is refused again, if it moves again first.
						</p>
					</>
				)}
			</div>
		</Banner>
	);
}
