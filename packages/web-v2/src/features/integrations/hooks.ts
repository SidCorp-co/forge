"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { integrationsApi } from "./api";
import type {
  CreateIntegrationInput,
  CreatePostmanInput,
  UpdateIntegrationInput,
  UpdatePostmanInput,
} from "./types";

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

// === ISS-395 — provider-agnostic hooks for the Coolify + Epodsystem sections.
// These use the generic `create`/`update` api over the discriminated body so a
// single hook serves both providers; the Postman hooks above stay unchanged. ===

/** Create a Coolify/Epodsystem integration. Returns the one-time `integrationSecret`. */
export function useCreateProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (body: CreateIntegrationInput) =>
      integrationsApi.create(projectId as string, body),
    onSuccess: () => {
      invalidate();
      toast({ title: "Integration saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save integration", description: formatApiError(err), tone: "error" }),
  });
}

/** Patch a Coolify/Epodsystem integration (config/secrets/active). */
export function useUpdateProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateIntegrationInput }) =>
      integrationsApi.update(projectId as string, id, body),
    onSuccess: () => {
      invalidate();
      toast({ title: "Integration saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save integration", description: formatApiError(err), tone: "error" }),
  });
}

/** Delete a Coolify/Epodsystem integration (provider-neutral toast copy). */
export function useDeleteProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => integrationsApi.remove(projectId as string, id),
    onSuccess: () => {
      invalidate();
      toast({ title: "Integration removed", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't remove integration", description: formatApiError(err), tone: "error" }),
  });
}

/** Rotate the inbound HMAC webhook secret. The new secret is returned ONCE. */
export function useRotateIntegrationSecret(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  return useMutation({
    mutationFn: (id: string) => integrationsApi.rotateSecret(projectId as string, id),
    onSuccess: () => invalidate(),
  });
}

/** Release the production deploy gate for an in-flight pipeline run. */
export function useConfirmProdDeploy(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => integrationsApi.confirmProdDeploy(projectId as string, id),
    onSuccess: (res) => {
      invalidate();
      toast({
        title: res.confirmed ? "Production deploy confirmed" : "No pending deploy to confirm",
        tone: res.confirmed ? "success" : "info",
      });
    },
    onError: (err) =>
      toast({ title: "Couldn't confirm deploy", description: formatApiError(err), tone: "error" }),
  });
}

/** Recent webhook deliveries for an integration. Disabled until `id` is set. */
export function useIntegrationDeliveries(projectId: string | undefined, id: string | null) {
  return useQuery({
    queryKey: ["integrations", "deliveries", projectId, id],
    queryFn: () => integrationsApi.deliveries(projectId as string, id as string),
    enabled: !!projectId && !!id,
  });
}
