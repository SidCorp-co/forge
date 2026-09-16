"use client";

import { Toggle } from "@/design";
import { useSetRunnerAdmission } from "../hooks";

/** Whether this runner may be offered jobs from the pool. */
export function PoolAdmission({
	projectId,
	runnerId,
	status,
	canEdit,
}: {
	projectId: string;
	runnerId: string;
	status: string;
	canEdit: boolean;
}) {
	const set = useSetRunnerAdmission(projectId);
	const withdrawn = status === "draining" || status === "disabled";

	return (
		<div className="flex items-start gap-3 border-line border-t pt-3">
			<Toggle
				checked={!withdrawn}
				onChange={(next) => set.mutate({ runnerId, admit: next })}
				disabled={!canEdit || set.isPending}
				aria-label="Take jobs from the pool"
			/>
			<div className="min-w-0">
				<div className="fg-body-sm text-fg">Takes jobs from the pool</div>
				<p className="fg-caption text-muted">
					{status === "disabled"
						? "Retired by an operator. Switch this back on to return it to the pool."
						: withdrawn
							? "Drained: work already running finishes, nothing new is offered or claimed."
							: "Offered work whenever this box is bound to the project."}
				</p>
			</div>
		</div>
	);
}
