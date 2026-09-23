"use client";

import { Toggle } from "@/design";
import { useSetRunnerAdmission } from "../hooks";

/**
 * Whether this runner may be offered jobs from the pool.
 *
 * What it does NOT reach is said out loud (ISS-1118): both `draining` and
 * `disabled` decide whether a NEW master is placed and end no pane already up,
 * and this was the control an owner reached for to stop one. `ResidentMaster`
 * below names the control that does.
 */
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
				<p className="fg-caption text-muted">
					Switching this off does not end a resident master session already
					running on the box — it decides what work is offered, not what is
					still running.
				</p>
			</div>
		</div>
	);
}
