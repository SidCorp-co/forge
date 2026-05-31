"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { runnersApi } from "./api";

/**
 * The caller's devices. Keyed `['devices','me']` — exactly the key the WS
 * event-router invalidates on `device.login`/`device.paired`/`device.revoked`,
 * so pending→approved and revoke reflect live with no extra wiring.
 */
export function useDevices() {
  return useQuery({
    queryKey: ["devices", "me"],
    queryFn: () => runnersApi.listDevices(),
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
      toast({ title: "Revoke failed", description: formatApiError(err), tone: "error" }),
  });
}

export function useInitPairing() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (deviceLabel: string) => runnersApi.initPairing(deviceLabel),
    onError: (err) =>
      toast({ title: "Could not mint code", description: formatApiError(err), tone: "error" }),
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
      toast({ title: "Rename failed", description: formatApiError(err), tone: "error" }),
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
    mutationFn: ({ projectId, repoPath }: { projectId: string; repoPath: string | null }) =>
      runnersApi.bindRunner(projectId, deviceId, repoPath),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices", deviceId, "runners"] });
      toast({ title: "Project assigned", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Assign failed", description: formatApiError(err), tone: "error" }),
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
      toast({ title: "Save failed", description: formatApiError(err), tone: "error" }),
  });
}

export function useUnbindRunner(deviceId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ projectId, runnerId }: { projectId: string; runnerId: string }) =>
      runnersApi.unbindRunner(projectId, runnerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices", deviceId, "runners"] });
      toast({ title: "Project unassigned", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Unassign failed", description: formatApiError(err), tone: "error" }),
  });
}
