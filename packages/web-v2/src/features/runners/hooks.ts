"use client";

import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { runnersApi } from "./api";

/**
 * The caller's devices. Keyed `['devices','me', orgId ?? null]` — a child of
 * `['devices','me']`, so the WS event-router (which invalidates the
 * `['devices','me']` PREFIX on `device.login`/`device.paired`/`device.revoked`
 * and reconnect) still refreshes every variant; pending→approved and revoke
 * reflect live with no extra wiring. ISS-477: pass `orgId` to scope the Runners
 * surface to the active org's devices; omit it (sessions/attention name
 * resolution) for the full owner-scoped list.
 */
export function useDevices(orgId?: string | null) {
	return useQuery({
		queryKey: ["devices", "me", orgId ?? null],
		queryFn: () => runnersApi.listDevices(orgId ?? undefined),
	});
}

export function useRevokeDevice() {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (id: string) => runnersApi.revokeDevice(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			toast({ title: "Device revoked", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Revoke failed",
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
	return useMutation({
		mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
			runnersApi.setDeviceDisabled(id, disabled),
		onSuccess: (_data, { disabled }) => {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			toast({
				title: disabled ? "Device turned off" : "Device turned on",
				tone: "success",
			});
		},
		onError: (err) =>
			toast({
				title: "Couldn't update device",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useInitPairing() {
	const { toast } = useToast();
	return useMutation({
		mutationFn: (deviceLabel: string) => runnersApi.initPairing(deviceLabel),
		onError: (err) =>
			toast({
				title: "Could not mint code",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useRenameDevice() {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			runnersApi.renameDevice(id, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", "me"] });
			toast({ title: "Device renamed", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Rename failed",
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

export function useBindRunner(deviceId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			projectId,
			repoPath,
		}: { projectId: string; repoPath: string | null }) =>
			runnersApi.bindRunner(projectId, deviceId, repoPath),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", deviceId, "runners"] });
			toast({ title: "Project assigned", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Assign failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function usePatchRunner(deviceId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			projectId,
			runnerId,
			repoPath,
			branch,
		}: {
			projectId: string;
			runnerId: string;
			repoPath: string | null;
			branch: string | null;
		}) => runnersApi.patchRunner(projectId, runnerId, { repoPath, branch }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", deviceId, "runners"] });
			toast({ title: "Runner saved", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Save failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useUnbindRunner(deviceId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			projectId,
			runnerId,
		}: { projectId: string; runnerId: string }) =>
			runnersApi.unbindRunner(projectId, runnerId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices", deviceId, "runners"] });
			toast({ title: "Project unassigned", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Unassign failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

// === Project-centric hooks (the project Runners screen) ===

/**
 * Device pools serving a project. Keyed `['projects', id, 'runners']`. The WS
 * event-router invalidates this on `runner.provision` so the live provision
 * stepper advances without manual refetch.
 */
export function useProjectRunners(projectId: string | null) {
	return useQuery({
		queryKey: ["projects", projectId, "runners"],
		queryFn: () => runnersApi.listProjectRunners(projectId as string),
		enabled: !!projectId,
	});
}

/**
 * Per-runner activity (status timeline + recent device sessions). Keyed
 * `['runners', runnerId, 'activity']`; `enabled` gates it so the row only
 * fetches when its Activity disclosure is open.
 */
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
 * `issue.pipelineHealth.changed` (fires on every job completion/failure +
 * dispatch tick, carries projectId) and on `runner.status`/`pipeline_run`
 * terminal events. The 10s `refetchInterval` is a backstop for any gap (e.g.
 * `job.assigned` rides the device room, so busy ONSET can lag up to one poll)
 * and re-anchors the row's elapsed counter to real `startedAt` values (the
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

export function useGitCredential(projectId: string | null) {
	return useQuery({
		queryKey: ["projects", projectId, "git-credential"],
		queryFn: () => runnersApi.getGitCredential(projectId as string),
		enabled: !!projectId,
	});
}

export function useSetGitCredential(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (
			body: { mode: "generate" } | { mode: "provide"; privateKey: string },
		) => runnersApi.setGitCredential(projectId, body),
		onSuccess: () => {
			qc.invalidateQueries({
				queryKey: ["projects", projectId, "git-credential"],
			});
			toast({ title: "Deploy key saved", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Could not save key",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useDeleteGitCredential(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: () => runnersApi.deleteGitCredential(projectId),
		onSuccess: () => {
			qc.invalidateQueries({
				queryKey: ["projects", projectId, "git-credential"],
			});
			toast({ title: "Deploy key removed", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Remove failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/**
 * Probe the stored deploy key against the repo (git ls-remote). Non-mutating —
 * exposes the result via `mutation.data` for an inline banner; only surfaces a
 * toast when the request itself fails (misconfig: no key / non-SSH URL / 503).
 */
export function useTestGitCredential(projectId: string) {
	const { toast } = useToast();
	return useMutation({
		mutationFn: () => runnersApi.testGitCredential(projectId),
		onError: (err) =>
			toast({
				title: "Could not test connection",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/**
 * Bind a device to a project (project-centric variant — invalidates the project
 * runners list rather than the device pools).
 */
export function useAssignDeviceToProject(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			deviceId,
			repoPath,
		}: { deviceId: string; repoPath: string | null }) =>
			runnersApi.bindRunner(projectId, deviceId, repoPath),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({ title: "Device assigned — provisioning…", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Assign failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** Unassign a device from a project (project-centric: invalidates project list). */
export function useUnassignDeviceFromProject(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (runnerId: string) =>
			runnersApi.unbindRunner(projectId, runnerId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({ title: "Device unassigned", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Unassign failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/**
 * Set (or clear, with null) the project's primary/default device. Invalidates
 * the project detail (['project', id]) so the "Primary" badge reflects live.
 */
export function useSetDefaultDevice(projectId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (deviceId: string | null) =>
      runnersApi.setDefaultDevice(projectId, deviceId),
    onSuccess: (_data, deviceId) => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      toast({
        title: deviceId ? "Primary device set" : "Primary device cleared",
        tone: "success",
      });
    },
    onError: (err) =>
      toast({ title: "Couldn't set primary", description: formatApiError(err), tone: "error" }),
  });
}

/** Re-provision a device (re-bind with same path re-queues provision). */
export function useReprovision(projectId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			deviceId,
			repoPath,
		}: { deviceId: string; repoPath: string | null }) =>
			runnersApi.bindRunner(projectId, deviceId, repoPath),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "runners"] });
			toast({ title: "Re-provisioning…", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Re-provision failed",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}
