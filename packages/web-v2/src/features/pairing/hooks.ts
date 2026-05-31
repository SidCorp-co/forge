"use client";

import { useMutation } from "@tanstack/react-query";
import { pairingApi } from "./api";

/** Approve a pending device-login pairing code. */
export function useApproveDevice() {
  return useMutation({
    mutationFn: (pairingCode: string) => pairingApi.approve(pairingCode),
  });
}
