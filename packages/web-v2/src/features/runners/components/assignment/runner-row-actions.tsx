import { Button } from "@/design";
import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
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
	const t = useCopy();

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
					{t("runners.row.remove")}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setConfirmRemove(false)}
				>
					{t("common.cancel")}
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
					{t("runners.device.turnOn")}
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
					{t("runners.row.reprovision")}
				</Button>
			)}
			<Button
				variant="ghost"
				size="sm"
				icon="trash"
				onClick={() => setConfirmRemove(true)}
			>
				{t("runners.row.unassign")}
			</Button>
		</span>
	);
}
