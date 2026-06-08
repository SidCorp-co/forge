"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { integrationConnectionsApi, integrationsApi } from "./api";
import type {
  BindExistingConnectionRequest,
  ConnectionCreateInput,
  ConnectionUpdateInput,
  CreateIntegrationInput,
  UpdateIntegrationInput,
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

/** Test connection. Does NOT toast on its own — the caller renders the result
 *  inline (user/email on success, clear error on a bad key). */
export function useTestIntegration(projectId: string | undefined) {
  return useMutation({
    mutationFn: (id: string) => integrationsApi.test(projectId as string, id),
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

// === ISS-408 / F3 — retry failed outbound deliveries ===

/** Re-dispatch a failed outbound delivery (202). Caller passes the deliveryId
 *  to `mutate`. On success, invalidates the delivery-list key so the new row
 *  appears once the worker records it. */
export function useRetryDelivery(projectId: string | undefined, bindingId: string | null) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      integrationsApi.retryDelivery(projectId as string, bindingId as string, deliveryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations", "deliveries", projectId, bindingId] });
      toast({ title: "Retry queued", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't retry delivery", description: formatApiError(err), tone: "error" }),
  });
}

// === ISS-401/C — owner-scoped connection hooks ===
// Connections belong to the authenticated principal, NOT a project, so these
// keys are NOT project-scoped: a single `['integration-connections']` cache
// entry serves every project view. The event-router invalidates this exact key
// on `integration.changed`; `replayOnReconnect` refreshes it after a drop.

/** Connections owned by the current user. Keyed `['integration-connections']`. */
export function useConnections() {
  return useQuery({
    queryKey: ["integration-connections"],
    queryFn: () => integrationConnectionsApi.list(),
  });
}

function useInvalidateConnections() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["integration-connections"] });
}

/** Create an owner-scoped connection (credential). */
export function useCreateConnection() {
  const invalidate = useInvalidateConnections();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (body: ConnectionCreateInput) => integrationConnectionsApi.create(body),
    onSuccess: () => {
      invalidate();
      toast({ title: "Connection created", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't create connection", description: formatApiError(err), tone: "error" }),
  });
}

/** Patch a connection (displayName/config/secrets/active). */
export function useUpdateConnection() {
  const invalidate = useInvalidateConnections();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ConnectionUpdateInput }) =>
      integrationConnectionsApi.update(id, body),
    onSuccess: () => {
      invalidate();
      toast({ title: "Connection saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save connection", description: formatApiError(err), tone: "error" }),
  });
}

/** Soft-delete a connection (active=false). */
export function useDeleteConnection() {
  const invalidate = useInvalidateConnections();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => integrationConnectionsApi.remove(id),
    onSuccess: () => {
      invalidate();
      toast({ title: "Connection removed", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't remove connection", description: formatApiError(err), tone: "error" }),
  });
}

// === ISS-408 / F3 — list bindings for a connection + share-existing flow ===

/**
 * Project+env bindings fed by one connection. Keyed
 * `['integration-connections', id, 'bindings']` — a CHILD of
 * `['integration-connections']`, so the existing event-router invalidator on
 * `integration.changed` cascades to this key with no extra wiring.
 */
export function useConnectionBindings(connectionId: string | null | undefined) {
  return useQuery({
    queryKey: ["integration-connections", connectionId, "bindings"],
    queryFn: () => integrationConnectionsApi.bindings(connectionId as string),
    enabled: !!connectionId,
  });
}

/**
 * Bind an existing connection to a project+env without re-entering the
 * credential. Returns the integration row + the one-time HMAC
 * `integrationSecret`. Invalidates both the connection cache (new binding) AND
 * the target project's integrations list/status (a new binding flips a card).
 */
export function useBindExistingConnection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BindExistingConnectionRequest }) =>
      integrationConnectionsApi.bindExisting(id, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["integration-connections"] });
      qc.invalidateQueries({ queryKey: ["integrations", "list", vars.body.projectId] });
      qc.invalidateQueries({ queryKey: ["integrations", "status", vars.body.projectId] });
      toast({ title: "Connection shared", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't share connection", description: formatApiError(err), tone: "error" }),
  });
}
