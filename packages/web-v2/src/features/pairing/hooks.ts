"use client";

import { useMutation } from "@tanstack/react-query";
import { pairingApi } from "./api";

/** Approve a pending device-login pairing code, optionally as an agent. */
export function useApproveDevice() {
  return useMutation({
    mutationFn: (args: { pairingCode: string; agentUserId?: string | null }) =>
      pairingApi.approve(args.pairingCode, args.agentUserId),
  });
}
