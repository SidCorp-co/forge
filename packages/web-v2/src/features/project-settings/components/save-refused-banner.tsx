"use client";

// What a refused settings save looks like to the person who made it.
//
// A save is refused when the document moved at a path this section writes. The person is
// owed three things and gets them here: WHICH settings changed under them, that NOTHING was
// written, and the re-read that makes the save possible — an action, not a sentence telling
// them to reload the page (ISS-1170).

import { useQueryClient } from "@tanstack/react-query";
import { Banner, Button } from "@/design";
import {
	formatPipelineConfigError,
	formatSettingsWriteError,
	writeConflicts,
} from "@/lib/api/error";

export function SaveRefusedBanner({
	projectId,
	error,
	onDismiss,
	document = "pipeline-config",
}: {
	projectId: string;
	error: unknown;
	onDismiss?: () => void;
	/** Which settings document to re-read — the query key whose data seeds this section. */
	document?: "pipeline-config" | "environments";
}) {
	const qc = useQueryClient();
	const stale = writeConflicts(error).length > 0;

	function reread() {
		qc.invalidateQueries({ queryKey: ["project", projectId, document] });
		qc.invalidateQueries({ queryKey: ["project", projectId] });
		onDismiss?.();
	}

	return (
		<Banner tone={stale ? "attention" : "danger"} onDismiss={onDismiss}>
			<div className="space-y-2">
				<p>
					{document === "environments"
						? formatSettingsWriteError(error)
						: formatPipelineConfigError(error)}
				</p>
				{stale && (
					<Button variant="secondary" size="sm" onClick={reread}>
						Load the current settings
					</Button>
				)}
			</div>
		</Banner>
	);
}
