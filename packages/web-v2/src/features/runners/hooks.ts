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
