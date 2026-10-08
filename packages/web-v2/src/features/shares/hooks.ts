"use client";

import type { ShareCreate } from "@forge/contracts/shares";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sharesApi } from "./api";

const sharesKey = (projectId: string | undefined) => ["project", projectId, "shares"] as const;

export function useShares(projectId: string | undefined) {
  return useQuery({
    queryKey: sharesKey(projectId),
    queryFn: () => sharesApi.list(projectId as string),
    enabled: Boolean(projectId),
  });
}

/** Read each time the dialog opens: a grant or the data policy may have changed since. */
export function useShareAudiences(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...sharesKey(projectId), "audiences"],
    queryFn: () => sharesApi.audiences(projectId as string),
    enabled: Boolean(projectId) && enabled,
    staleTime: 0,
    retry: false,
  });
}

export function useCreateShare(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ShareCreate) => sharesApi.create(projectId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(projectId) }),
  });
}

/** Revoking answers nothing the list trusts: the row reads revoked once the list is read again. */
export function useRevokeShare(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => sharesApi.revoke(projectId, shareId),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(projectId) }),
  });
}
