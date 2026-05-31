"use client";

// web-v2 feature module: runners / devices — React Query hooks. Reconciles
// ISS-296 (per-project runners + quota) with ISS-305 (browser-approve device
// login).
//
// Query-key contract: keys MUST match the WS event-router cases or live updates
// silently no-op. `lib/ws/event-router.ts` invalidates:
//   • `['devices']`              on device.status / device.statusChanged and
//                                device.login / device.paired / device.revoked
//   • `['runners', projectId]`   on runner.created / updated / deleted
//   • `['runners']` + `['devices']` on replayOnReconnect.
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { runnersApi } from "./api";
import type { RunnerDetail } from "./types";

/** The caller's devices. Keyed `['devices','mine']` — WS-invalidated. */
export function useMyDevices() {
  return useQuery({
    queryKey: ["devices", "mine"],
    queryFn: () => runnersApi.listMyDevices(),
  });
}

/** Runner rows for one project. Keyed `['runners', projectId]`. */
export function useProjectRunners(projectId: string | undefined) {
  return useQuery({
    queryKey: ["runners", projectId],
    queryFn: () => runnersApi.listProjectRunners(projectId as string),
    enabled: !!projectId,
  });
}

/**
 * Fan out `GET /api/runners?projectId=` across every visible project and
 * flatten into a single runner list (deviceId carries the grouping). Bounded
 * by the caller's project count. Each per-project query keeps the
 * `['runners', projectId]` key so the WS router invalidates them individually.
 */
export function useAllRunners(projectIds: string[]) {
  const results = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["runners", projectId],
      queryFn: () => runnersApi.listProjectRunners(projectId),
    })),
  });
  const runners: RunnerDetail[] = results.flatMap((r) => r.data?.runners ?? []);
  return {
    runners,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
    refetch: () => results.forEach((r) => r.refetch()),
  };
}

/** Shared mutation factory: invalidate devices+runners on success, toast errors. */
function useRunnerMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { successMessage?: (data: TData) => string } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["runners"] });
      qc.invalidateQueries({ queryKey: ["devices"] });
      if (opts.successMessage) toast({ title: opts.successMessage(data), tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useRefreshQuota() {
  return useRunnerMutation((runnerId: string) => runnersApi.refreshQuota(runnerId), {
    successMessage: () => "Quota refreshed",
  });
}

export function useExcludeRunner() {
  return useRunnerMutation((runnerId: string) => runnersApi.excludeRunner(runnerId), {
    successMessage: () => "Runner excluded",
  });
}

export function useIncludeRunner() {
  return useRunnerMutation((runnerId: string) => runnersApi.includeRunner(runnerId), {
    successMessage: () => "Runner re-enabled",
  });
}

export function useRenameDevice() {
  return useRunnerMutation(
    ({ id, name }: { id: string; name: string }) => runnersApi.renameDevice(id, name),
    { successMessage: () => "Device renamed" },
  );
}

export function useRevokeDevice() {
  return useRunnerMutation((id: string) => runnersApi.revokeDevice(id), {
    successMessage: () => "Device revoked",
  });
}

/**
 * Pair-a-device (ISS-305 browser-approve login): mint a device-login pairing
 * code via `POST /api/devices/login/init`. Not invalidating — the PairPanel
 * shows the returned code directly; the device list refreshes live via WS
 * (`device.login`/`device.paired`) once the device is approved.
 */
export function useInitPairing() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (deviceLabel: string) => runnersApi.initPairing(deviceLabel),
    onError: (err) =>
      toast({ title: "Could not mint code", description: formatApiError(err), tone: "error" }),
  });
}
