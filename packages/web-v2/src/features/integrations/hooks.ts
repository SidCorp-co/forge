"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { integrationsApi } from "./api";
import type { CreatePostmanInput, UpdatePostmanInput } from "./types";

/** Integration status cards for a project. Keyed `['integrations','status',id]`. */
export function useIntegrationsStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", "status", projectId],
    queryFn: () => integrationsApi.status(projectId as string),
    enabled: !!projectId,
  });
}

/** All integration rows for a project. Keyed `['integrations','list',id]`. */
export function useIntegrationsList(projectId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", "list", projectId],
    queryFn: () => integrationsApi.list(projectId as string),
    enabled: !!projectId,
  });
}

function useInvalidateIntegrations(projectId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["integrations", "list", projectId] });
    qc.invalidateQueries({ queryKey: ["integrations", "status", projectId] });
  };
}

export function useCreateIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: CreatePostmanInput) =>
      integrationsApi.createPostman(projectId as string, input),
    onSuccess: () => {
      invalidate();
      toast({ title: "Postman integration created", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't create integration", description: formatApiError(err), tone: "error" }),
  });
}

export function useUpdateIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePostmanInput }) =>
      integrationsApi.updatePostman(projectId as string, id, input),
    onSuccess: () => {
      invalidate();
      toast({ title: "Postman integration saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save integration", description: formatApiError(err), tone: "error" }),
  });
}

/** Test connection. Does NOT toast on its own — the caller renders the result
 *  inline (user/email on success, clear error on a bad key). */
export function useTestIntegration(projectId: string | undefined) {
  return useMutation({
    mutationFn: (id: string) => integrationsApi.test(projectId as string, id),
  });
}

export function useDeleteIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => integrationsApi.remove(projectId as string, id),
    onSuccess: () => {
      invalidate();
      toast({ title: "Postman integration removed", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't remove integration", description: formatApiError(err), tone: "error" }),
  });
}
