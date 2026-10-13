import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToastWrite } from "@/providers/toast-write";
import { useQuery } from "@tanstack/react-query";
import { runnersApi } from "./api";
import { runnerKeys, runnerQueries } from "./queries";
import { deviceVersionLabel } from "./types";

/**
 * The caller's own devices. Keyed `['devices','me', orgId ?? null]` — a child of
 * `['devices','me']`, so the WS event-router (which invalidates the
 * `['devices','me']` PREFIX on `device.login`/`device.paired`/`device.revoked`
 * and reconnect) still refreshes every variant; pending→approved and revoke
 * reflect live with no extra wiring.
 *
 * `orgId` NARROWS this list to the caller's devices that serve a project in that
 * org. ISS-477 had the Runners surface pass it; ISS-1162 reversed that, because a
 * just-paired device has no runner row and so belongs to no org scope — under the
 * filter it was on no screen in the app. The Runners surface now reads the whole
 * owner-scoped list here and the organisation's from `useOrgDevices`.
 */
export function useDevices(orgId?: string | null) {
	return useQuery(runnerQueries.myDevices(orgId ?? null));
}

/**
 * The organisation's devices, over the projects this caller can see. Keyed
 * `['devices','org', orgId]`, which the event-router invalidates beside
 * `['devices','me']`. That is not enough on its own: a pairing, revoke or
 * turn-off by ANOTHER member publishes to that member's own room and reaches no
 * client here, so without the poll this list would hold a revoked box and its
 * assignment count until a reconnect happened to occur (ISS-1162). The interval
 * matches `useProjectRunners`, which carries the same kind of report.
 */
export function useOrgDevices(orgId: string | null) {
	return useQuery(runnerQueries.orgDevices(orgId));
}

export { ORG_DEVICES_REFRESH_MS } from "./queries";

export function useRevokeDevice() {
	const t = useCopy();
	return useToastWrite(runnersApi.revokeDevice, { touches: [runnerKeys.myDevicesAll()], said: t("runners.toast.revoked"), failed: t("runners.toast.revokeFailed") });
}

/**
 * Reversible "turn off" toggle for a device. Invalidates the `['devices','me']`
 * prefix so every org-scoped variant of the list reflects the new state; the
 * server also broadcasts `device.status` so other tabs refresh live.
 */
export function useSetDeviceDisabled() {
	const t = useCopy();
	return useToastWrite(({ id, disabled }: { id: string; disabled: boolean }) => runnersApi.setDeviceDisabled(id, disabled), {
		touches: [runnerKeys.myDevicesAll(), ["projects"], runnerKeys.runners],
		said: (_d, { disabled }) => (disabled ? t("runners.toast.turnedOff") : t("runners.toast.turnedOn")),
		failed: t("runners.toast.updateFailed"),
	});
}

export function useRenameDevice() {
	const t = useCopy();
	return useToastWrite(({ id, name }: { id: string; name: string }) => runnersApi.renameDevice(id, name), {
		touches: [runnerKeys.myDevicesAll()],
		said: t("runners.toast.renamed"),
		failed: t("runners.toast.renameFailed"),
	});
}

/**
 * The project pools a device serves. Keyed `['devices', id, 'runners']` — a
 * child of `['devices']`, so the WS reconnect replay (which invalidates
 * `['devices','me']`) leaves it to its own window-focus/explicit refetch.
 */
export function useDeviceRunners(deviceId: string | null) {
	return useQuery(runnerQueries.deviceRunners(deviceId));
}

export function useSetRunnerAdmission(projectId: string) {
	const t = useCopy();
	return useToastWrite(({ runnerId, admit }: { runnerId: string; admit: boolean }) => runnersApi.patchRunnerStatus(runnerId, admit ? "online" : "draining"), {
		touches: [runnerKeys.projectRunners(projectId)],
		said: (_d, v) => (v.admit ? t("runners.toast.backInPool") : { title: t("runners.toast.drained"), description: t("runners.toast.drainedBody") }),
		failed: t("runners.toast.saveFailed"),
	});
}

export function useSetRunnerLabels(projectId: string) {
	const t = useCopy();
	return useToastWrite(({ runnerId, labels }: { runnerId: string; labels: string[] }) => runnersApi.patchRunner(projectId, runnerId, { labels }), {
		touches: [runnerKeys.projectRunners(projectId)],
		said: t("runners.toast.labelsSaved"),
		failed: t("runners.toast.saveFailed"),
	});
}

/**
 * Device pools serving a project. Keyed `['projects', id, 'runners']`. The WS
 * event-router invalidates this on `runner.provision` so the live provision
 * stepper advances without manual refetch. Each row's pool report is renewed by
 * its box's heartbeat and no event announces that, so the list is read again on
 * the heartbeat's cadence: a report stays as current as core's copy of it.
 */
export function useProjectRunners(projectId: string | null) {
	return useQuery(runnerQueries.projectRunners(projectId));
}

export function useRunnerActivity(runnerId: string, enabled: boolean) {
	return useQuery(runnerQueries.activity(runnerId, enabled));
}

/**
 * Live snapshot of which runners are executing a job for a project. Keyed
 * `['projects', id, 'active-runners']`. Invalidated by the event-router on
 * `issue.pipelineHealth.changed`, every `job.*` move, `runner.*` and every
 * `pipeline_run` move. The 10s `refetchInterval` is a backstop for any gap
 * (a job's claim sends no frame of its own) and re-anchors the row's elapsed counter to real `startedAt` values (the
 * per-second tick itself is purely client-side).
 */
export function useActiveRunners(projectId: string | null) {
	return useQuery(runnerQueries.activeRunners(projectId));
}

/**
 * Bind a device to the project, the one mutation behind both "assign" and "re-provision": core
 * answers either by queuing a provision for the binding.
 */
function useBindRunner(projectId: string, copy: { success: ProductCopyKey; failure: ProductCopyKey }) {
	const t = useCopy();
	return useToastWrite(({ deviceId, repoPath }: { deviceId: string; repoPath: string | null }) => runnersApi.bindRunner(projectId, deviceId, repoPath), {
		touches: [runnerKeys.projectRunners(projectId)],
		said: t(copy.success),
		failed: t(copy.failure),
	});
}

export function useAssignDeviceToProject(projectId: string) {
	return useBindRunner(projectId, {
		success: "runners.toast.assigned",
		failure: "runners.toast.assignFailed",
	});
}

export function useUnassignDeviceFromProject(projectId: string) {
	const t = useCopy();
	return useToastWrite((runnerId: string) => runnersApi.unbindRunner(projectId, runnerId), {
		touches: [runnerKeys.projectRunners(projectId)],
		said: t("runners.toast.unassigned"),
		failed: t("runners.toast.unassignFailed"),
	});
}

/**
 * Clear a runner's recorded faults (last error + limit + quarantine) and let
 * dispatch retry it. Invalidates the project runner list plus `['runners']` so
 * the dashboard health card drops the badge with the screen.
 */
export function useClearRunnerError(projectId: string) {
	const t = useCopy();
	return useToastWrite((runnerId: string) => runnersApi.clearRunnerError(projectId, runnerId), {
		touches: [runnerKeys.projectRunners(projectId), runnerKeys.runners],
		said: ({ cleared }) => (cleared ? t("runners.toast.cleared") : t("runners.toast.nothingToClear")),
		failed: t("runners.toast.clearFailed"),
	});
}

/** Re-provision a device (re-bind with same path re-queues provision). */
export function useReprovision(projectId: string) {
	return useBindRunner(projectId, {
		success: "runners.toast.reprovisioning",
		failure: "runners.toast.reprovisionFailed",
	});
}

/** A device's version line in the interface language, for a surface outside the Runners screens. */
export function useDeviceVersionLabel(): (agentVersion: string | null | undefined) => string {
	const language = useInterfaceLanguage();
	return (agentVersion) => deviceVersionLabel(agentVersion, language);
}
