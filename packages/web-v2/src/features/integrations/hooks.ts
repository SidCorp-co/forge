"use client";

import type { ConnectionDirectoryItem } from "@forge/contracts";
import { useToast } from "@/providers/toast-provider";
import {
  type MutateOptions,
  type QueryClient,
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import { integrationConnectionsApi, integrationsApi } from "./api";
import type {
  BindingListResponse,
  BindExistingConnectionRequest,
  ConnectionUpdateInput,
  CreateIntegrationInput,
  IntegrationSummary,
  ProjectIntegrationActs,
  UpdateIntegrationInput,
} from "./types";
import { failureToast } from "@/lib/api/failure-toast";
import { ApiError } from "@/lib/api/client";

/**
 * A write refused for who sent it, or for a row gone from under them: what the screen offered was
 * read before the refusal and may no longer hold, so the list it came from is read again (ISS-1421
 * r27: after a demotion the Integrations page went on offering Disable, Enable, Remove and Clear).
 */
function refusedForTheReader(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 404);
}

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

/**
 * What the reader may do on the project's Integrations tab beyond any one binding, as core decides
 * it; null until the list is read, which offers nothing rather than guessing (ISS-1421 r27).
 */
export function useProjectIntegrationActs(projectId: string | undefined): ProjectIntegrationActs | null {
  return useIntegrationsList(projectId).data?.may ?? null;
}

/**
 * Every cached project list reads a write's own answer before any refetch. A drawer that waited for
 * the refetch went on showing the state before the write for as long as that read did not land,
 * and the person who pressed Enabled was told it had not taken (ISS-1421 r12).
 */
function writeThrough(qc: QueryClient, edit: (row: IntegrationSummary) => IntegrationSummary): void {
  qc.setQueriesData<BindingListResponse>({ queryKey: ["integrations", "list"] }, (list) => {
    if (!list) return list;
    const items = list.items.map(edit);
    return { ...list, items, bindings: items };
  });
}

function writeBinding(qc: QueryClient, saved: IntegrationSummary): void {
  writeThrough(qc, (row) => (row.id === saved.id ? saved : row));
}

function writeConnectionActive(qc: QueryClient, connectionId: string, active: boolean): void {
  writeThrough(qc, (row) =>
    row.connectionId === connectionId
      ? { ...row, connectionActive: active, active: row.bindingActive && active }
      : row,
  );
}

function useInvalidateIntegrations(projectId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    // A save from the tab makes or changes a connection, which the Share section lists (ISS-1421).
    qc.invalidateQueries({ queryKey: ["integration-connections"] });
    qc.invalidateQueries({ queryKey: ["integrations", "list", projectId] });
    qc.invalidateQueries({ queryKey: ["integrations", "status", projectId] });
    qc.invalidateQueries({
      queryKey: ["integrations", "mcp-preview", projectId],
    });
  };
}

/** What the dispatch resolvers will inject into this project's runners
 *  (`mcpServers`), redacted server-side. Keyed `['integrations','mcp-preview',id]`. */
export function useMcpPreview(projectId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", "mcp-preview", projectId],
    queryFn: () => integrationsApi.mcpPreview(projectId as string),
    enabled: !!projectId,
  });
}

/** Rooms the RC bot is a member of, via an existing binding's stored credential
 *  — feeds the room name picker. Keyed `['integrations','rc-rooms',project,id]`. */
export function useRocketchatRooms(
  projectId: string | undefined,
  integrationId: string | undefined,
) {
  return useQuery({
    queryKey: ["integrations", "rc-rooms", projectId, integrationId],
    queryFn: () =>
      integrationsApi.rocketchatRooms(projectId as string, {
        integrationId: integrationId as string,
      }),
    enabled: !!projectId && !!integrationId,
    staleTime: 60_000,
  });
}

/** Same probe with bare credentials — the connect form's "Load rooms" button
 *  (nothing persisted yet, so the caller supplies the credential). */
export function useProbeRocketchatRooms(projectId: string | undefined) {
  return useMutation({
    mutationFn: (body: { serverUrl: string; authToken: string; userId: string }) =>
      integrationsApi.rocketchatRooms(projectId as string, body),
  });
}

/** Start the GitHub App manifest flow. It invalidates nothing: no connection exists until GitHub
 *  redirects back through the callback, so a refetch would re-read the same empty list. */
export function useGitHubConnect(projectId: string | undefined) {
  return useMutation({
    mutationFn: (params: { org?: string; orgId?: string }) =>
      integrationsApi.githubConnect(projectId as string, params),
  });
}

export function useGitHubRepositories(
  projectId: string | undefined,
  connectionId: string | undefined,
) {
  return useQuery({
    queryKey: ["integrations", "github-repos", projectId, connectionId],
    queryFn: () => integrationsApi.githubRepositories(projectId as string, connectionId as string),
    enabled: !!projectId && !!connectionId,
  });
}

/** ISS-925 — the deploy-target pick-list. `auth` is either a saved binding or
 *  the credential still in the create form, so the picker works on a first save. */
export function useCoolifyApplications(
  projectId: string | undefined,
  auth: { integrationId: string } | { baseUrl: string; apiToken: string } | null,
) {
  return useQuery({
    queryKey: ["integrations", "coolify-apps", projectId, JSON.stringify(auth)],
    queryFn: () => integrationsApi.coolifyApplications(projectId as string, auth as never),
    enabled: !!projectId && !!auth,
    retry: false,
  });
}

/** The bound targets with the identity Coolify reports for each. */
export function useCoolifyTargets(projectId: string | undefined, integrationId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", "coolify-targets", projectId, integrationId],
    queryFn: () => integrationsApi.coolifyTargets(projectId as string, integrationId as string),
    enabled: !!projectId && !!integrationId,
    retry: false,
  });
}

export function useTestIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  return useMutation({
    mutationFn: (id: string) => integrationsApi.test(projectId as string, id),
    onSettled: () => invalidate(),
  });
}


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
    onError: (err) => {
      if (refusedForTheReader(err)) invalidate();
      toast(failureToast(err, "The integration was not saved"));
    },
  });
}

/** Patch a Coolify/Epodsystem integration (config/secrets/active). */
/** `failureSaidHere`: the caller shows a refusal where it was asked, so a toast would say it twice. */
export function useUpdateProviderIntegration(
  projectId: string | undefined,
  { failureSaidHere = false }: { failureSaidHere?: boolean } = {},
) {
  const qc = useQueryClient();
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateIntegrationInput }) =>
      integrationsApi.update(projectId as string, id, body),
    onSuccess: (answer) => {
      writeBinding(qc, answer.integration);
      invalidate();
      toast({ title: "Integration saved", tone: "success" });
    },
    onError: (err) => {
      if (refusedForTheReader(err)) invalidate();
      if (!failureSaidHere) toast(failureToast(err, "The integration was not saved"));
    },
  });
}

/**
 * One write per intent: a call made while the last is still in flight is dropped. A double-click on a
 * confirming Disconnect sent DELETE twice, the second answering that the first had already removed it
 * (ISS-1421 r25); `isPending` reaches the button a render too late to stop the second click.
 */
export function useOneWritePerIntent<TData, TError, TVariables, TContext>(
  mutation: UseMutationResult<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const busy = useRef(false);
  const mutate = (
    variables: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>,
  ) => {
    if (busy.current) return;
    busy.current = true;
    mutation.mutate(variables, {
      ...options,
      onSettled: (...settled) => {
        busy.current = false;
        options?.onSettled?.(...settled);
      },
    });
  };
  return { ...mutation, mutate } as UseMutationResult<TData, TError, TVariables, TContext>;
}

/** Take a binding off this project: a soft switch-off the toast names as the disconnect it is. */
export function useDeleteProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: (id: string) => integrationsApi.remove(projectId as string, id),
    onSuccess: () => {
      invalidate();
      toast({ title: "Disconnected from this project", tone: "success" });
    },
    onError: (err) => {
      if (refusedForTheReader(err)) invalidate();
      toast(failureToast(err, "It was not disconnected from this project"));
    },
  });
  return useOneWritePerIntent(mutation);
}


/** Release the production deploy gate for an in-flight pipeline run. */
export function useConfirmProdDeploy(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      integrationsApi.confirmProdDeploy(projectId as string, id),
    onSuccess: (res) => {
      invalidate();
      toast({
        title: res.confirmed
          ? "Live deploy confirmed"
          : "No pending deploy to confirm",
        tone: res.confirmed ? "success" : "info",
      });
    },
    onError: (err) =>
      toast(failureToast(err, "The deploy was not confirmed")),
  });
}

/** Recent webhook deliveries for an integration. Disabled until `id` is set. */
export function useIntegrationDeliveries(
  projectId: string | undefined,
  id: string | null,
) {
  return useQuery({
    queryKey: ["integrations", "deliveries", projectId, id],
    queryFn: () =>
      integrationsApi.deliveries(projectId as string, id as string),
    enabled: !!projectId && !!id,
  });
}


/** Re-dispatch a failed outbound delivery (202). Caller passes the deliveryId
 *  to `mutate`. On success, invalidates the delivery-list key so the new row
 *  appears once the worker records it. */
export function useRetryDelivery(
  projectId: string | undefined,
  bindingId: string | null,
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      integrationsApi.retryDelivery(
        projectId as string,
        bindingId as string,
        deliveryId,
      ),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["integrations", "deliveries", projectId, bindingId],
      });
      toast({ title: "Retry queued", tone: "success" });
    },
    onError: (err) =>
      toast(failureToast(err, "The delivery was not retried")),
  });
}

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

/** Whether the caller may manage a connection, read off the server's own `access.canManage`; a row
 *  without the field is not manageable (ISS-1216). */
export function useCanManageConnection(
  connection: Pick<ConnectionDirectoryItem, "access"> | null,
): boolean {
  return connection?.access?.canManage === true;
}

/** A body that only switches a connection says so, so its toast names that act rather than a save. */
function switchedTo(body: ConnectionUpdateInput): boolean | null {
  const keys = Object.keys(body);
  return keys.length === 1 && typeof body.active === "boolean" ? body.active : null;
}

function useInvalidateConnections() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["integration-connections"] });
    qc.invalidateQueries({ queryKey: ["integrations"] });
  };
}

/** Patch a connection (displayName/config/secrets/active). */
export function useUpdateConnection() {
  const qc = useQueryClient();
  const invalidate = useInvalidateConnections();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ConnectionUpdateInput }) =>
      integrationConnectionsApi.update(id, body),
    onSuccess: (answer, { body }) => {
      writeConnectionActive(qc, answer.connection.id, answer.connection.active);
      invalidate();
      const on = switchedTo(body);
      const title = on === null ? "Connection saved" : on ? "Connection turned on" : "Connection turned off";
      toast({ title, tone: "success" });
    },
    // "The connection was not saved" headed a refused Enable whose key had been saved (ISS-1421 r26).
    onError: (err, { body }) => {
      if (refusedForTheReader(err)) invalidate();
      const on = switchedTo(body);
      const title =
        on === null
          ? "The connection was not saved"
          : on
            ? "The connection was not turned on"
            : "The connection was not turned off";
      toast(failureToast(err, title));
    },
  });
}

export function useTestConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: integrationConnectionsApi.test,
    onSettled: invalidate,
  });
}

/** Soft-delete a connection (active=false — every binding stops resolving). */
export function useRemoveConnection() {
  const invalidate = useInvalidateConnections();
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: integrationConnectionsApi.remove,
    onSuccess: () => {
      invalidate();
      toast({ title: "Connection removed", tone: "success" });
    },
    onError: (err) => {
      if (refusedForTheReader(err)) invalidate();
      toast(failureToast(err, "The connection was not removed"));
    },
  });
  return useOneWritePerIntent(mutation);
}


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
    mutationFn: ({
      id,
      body,
    }: { id: string; body: BindExistingConnectionRequest }) =>
      integrationConnectionsApi.bindExisting(id, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["integration-connections"] });
      qc.invalidateQueries({
        queryKey: ["integrations", "list", vars.body.projectId],
      });
      qc.invalidateQueries({
        queryKey: ["integrations", "status", vars.body.projectId],
      });
      // The Agent MCP servers panel reads what a share now gives agents (ISS-1421 r6, criterion 99).
      qc.invalidateQueries({
        queryKey: ["integrations", "mcp-preview", vars.body.projectId],
      });
      toast({ title: "Connection shared", tone: "success" });
    },
    onError: (err) =>
      toast(failureToast(err, "The connection was not shared")),
  });
}
