"use client";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { runnersApi } from "./api";
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
	return useQuery({
		queryKey: ["devices", "me", orgId ?? null],
		queryFn: () => runnersApi.listDevices(orgId ?? undefined),
	});
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
	return useQuery({
		queryKey: ["devices", "org", orgId],
		queryFn: () => runnersApi.listOrgDevices(orgId as string),
		enabled: !!orgId,
		refetchInterval: ORG_DEVICES_REFRESH_MS,
	});
}

export const ORG_DEVICES_REFRESH_MS = 30_000;

export function useRevokeDevice() {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: runnersApi.revokeDevice,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			toast({ title: t("runners.toast.revoked"), tone: "success" });
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.revokeFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/**
 * Reversible "turn off" toggle for a device. Invalidates the `['devices','me']`
 * prefix so every org-scoped variant of the list reflects the new state; the
 * server also broadcasts `device.status` so other tabs refresh live.
 */
export function useSetDeviceDisabled() {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
			runnersApi.setDeviceDisabled(id, disabled),
		onSuccess: (_data, { disabled }) => {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			qc.invalidateQueries({ queryKey: ["projects"] });
			qc.invalidateQueries({ queryKey: ["runners"] });
			toast({
				title: disabled ? t("runners.toast.turnedOff") : t("runners.toast.turnedOn"),
				tone: "success",
			});
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.updateFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useRenameDevice() {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			runnersApi.renameDevice(id, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			toast({ title: t("runners.toast.renamed"), tone: "success" });
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.renameFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/**
 * The project pools a device serves. Keyed `['devices', id, 'runners']` — a
 * child of `['devices']`, so the WS reconnect replay (which invalidates
 * `['devices','me']`) leaves it to its own window-focus/explicit refetch.
 */
export function useDeviceRunners(deviceId: string | null) {
	return useQuery({
		queryKey: ["devices", deviceId, "runners"],
		queryFn: () => runnersApi.listDeviceRunners(deviceId as string),
		enabled: !!deviceId,
	});
}

export function useSetRunnerAdmission(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: ({ runnerId, admit }: { runnerId: string; admit: boolean }) =>
			runnersApi.patchRunnerStatus(runnerId, admit ? "online" : "draining"),
		onSuccess: (_d, v) => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({
				title: v.admit ? t("runners.toast.backInPool") : t("runners.toast.drained"),
				description: v.admit ? undefined : t("runners.toast.drainedBody"),
				tone: "success",
			});
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.saveFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useSetRunnerLabels(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: ({ runnerId, labels }: { runnerId: string; labels: string[] }) =>
			runnersApi.patchRunner(projectId, runnerId, { labels }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({ title: t("runners.toast.labelsSaved"), tone: "success" });
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.saveFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
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
	return useQuery({
		queryKey: ["projects", projectId, "runners"],
		queryFn: () => runnersApi.listProjectRunners(projectId as string),
		enabled: !!projectId,
		refetchInterval: 30_000,
	});
}

export function useRunnerActivity(runnerId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["runners", runnerId, "activity"],
		queryFn: () => runnersApi.getRunnerActivity(runnerId),
		enabled,
	});
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
	return useQuery({
		queryKey: ["projects", projectId, "active-runners"],
		queryFn: () => runnersApi.listActiveRunners(projectId as string),
		enabled: !!projectId,
		refetchInterval: 10_000,
	});
}

/**
 * Bind a device to the project, the one mutation behind both "assign" and "re-provision": core
 * answers either by queuing a provision for the binding.
 */
function useBindRunner(
	projectId: string,
	copy: { success: ProductCopyKey; failure: ProductCopyKey },
) {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: ({
			deviceId,
			repoPath,
		}: { deviceId: string; repoPath: string | null }) =>
			runnersApi.bindRunner(projectId, deviceId, repoPath),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({ title: t(copy.success), tone: "success" });
		},
		onError: (err) =>
			toast({
				title: t(copy.failure),
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useAssignDeviceToProject(projectId: string) {
	return useBindRunner(projectId, {
		success: "runners.toast.assigned",
		failure: "runners.toast.assignFailed",
	});
}

export function useUnassignDeviceFromProject(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: (runnerId: string) =>
			runnersApi.unbindRunner(projectId, runnerId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({ title: t("runners.toast.unassigned"), tone: "success" });
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.unassignFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/**
 * Clear a runner's recorded faults (last error + limit + quarantine) and let
 * dispatch retry it. Invalidates the project runner list plus `['runners']` so
 * the dashboard health card drops the badge with the screen.
 */
export function useClearRunnerError(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	const t = useCopy();
	return useMutation({
		mutationFn: (runnerId: string) =>
			runnersApi.clearRunnerError(projectId, runnerId),
		onSuccess: ({ cleared }) => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			qc.invalidateQueries({ queryKey: ["runners"] });
			toast({
				title: cleared ? t("runners.toast.cleared") : t("runners.toast.nothingToClear"),
				tone: "success",
			});
		},
		onError: (err) =>
			toast({
				title: t("runners.toast.clearFailed"),
				description: formatApiError(err),
				tone: "error",
			}),
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
