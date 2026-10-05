import { Button } from "@/design";
import { useState } from "react";
import { useReprovision, useSetDeviceDisabled, useUnassignDeviceFromProject } from "../../hooks";
import type { ProjectRunner } from "../../types";

/** Turn the device back on, re-provision its checkout, or unassign it behind a confirm. */
export function RunnerRowActions({
	runner,
	projectId,
	deviceDisabled,
}: {
	runner: ProjectRunner;
	projectId: string;
	deviceDisabled: boolean;
}) {
	const reprovision = useReprovision(projectId);
	const unassign = useUnassignDeviceFromProject(projectId);
	const setDisabled = useSetDeviceDisabled();
	const [confirmRemove, setConfirmRemove] = useState(false);

	if (confirmRemove) {
		return (
			<span className="inline-flex items-center gap-1.5">
				<Button
					variant="danger"
					size="sm"
					icon="trash"
					loading={unassign.isPending}
					onClick={() =>
						unassign.mutate(runner.runnerId, {
							onSettled: () => setConfirmRemove(false),
						})
					}
				>
					Remove
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setConfirmRemove(false)}
				>
					Cancel
				</Button>
			</span>
		);
	}

	return (
		<span className="inline-flex items-center gap-1">
			{runner.deviceId && deviceDisabled && (
				<Button
					variant="secondary"
					size="sm"
					icon="play"
					loading={setDisabled.isPending}
					onClick={() =>
						setDisabled.mutate({
							id: runner.deviceId as string,
							disabled: false,
						})
					}
				>
					Turn on
				</Button>
			)}
			{runner.deviceId && (
				<Button
					variant="ghost"
					size="sm"
					icon="rerun"
					loading={reprovision.isPending}
					onClick={() =>
						reprovision.mutate({
							deviceId: runner.deviceId as string,
							repoPath: runner.repoPath,
						})
					}
				>
					Re-provision
				</Button>
			)}
			<Button
				variant="ghost"
				size="sm"
				icon="trash"
				onClick={() => setConfirmRemove(true)}
			>
				Unassign
			</Button>
		</span>
	);
}
