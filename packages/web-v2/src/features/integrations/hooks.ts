
import { useOrgs } from "@/features/orgs";
import { invalidateBindingChange } from "@/features/project-config";
import { useProjects } from "@/features/projects";
import { isOrgAdmin } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { integrationConnectionsApi, integrationsApi } from "./api";
import { useAlsoBind } from "./also-bind";
import {
  type BindConnectionInput,
  bindConnection,
  bindConnectionInto,
  bindingRefusalText,
  type CreateIntegrationInput,
  createIntegration,
  type UpdateIntegrationInput,
  updateIntegration,
} from "./bind-actions";
import type {
  ConnectionBindingItem,
  ConnectionUpdateInput,
  IntegrationSummary,
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
    void qc.invalidateQueries({ queryKey: ["integrations", "list", projectId] });
    void qc.invalidateQueries({ queryKey: ["integrations", "status", projectId] });
    void qc.invalidateQueries({
      queryKey: ["integrations", "mcp-preview", projectId],
    });
  };
}

/** After a binding write: the integration views, and every panel that reads the binding. */
function useInvalidateBindingChange(projectId: string | undefined) {
  const qc = useQueryClient();
  const invalidateIntegrations = useInvalidateIntegrations(projectId);
  return () => {
    invalidateIntegrations();
    invalidateBindingChange(qc, projectId);
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

/** The rooms a bot connection this project is not bound to yet can answer in: the support-room form's group picker. */
export function useConnectionRocketchatRooms(projectId: string | undefined, connectionId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", "rc-rooms", projectId, "connection", connectionId],
    queryFn: () => integrationsApi.rocketchatConnectionRooms(projectId as string, connectionId as string),
    enabled: !!projectId && !!connectionId,
    staleTime: 60_000,
    retry: false,
  });
}

/** A project's bound rooms with their session and health, read again every 30 s (REQ-75 r5 BC-26). */
export function useSupportRooms(projectId: string | undefined) {
  return useQuery({
    queryKey: ["integrations", "support-rooms", projectId],
    queryFn: () => integrationsApi.supportRooms(projectId as string),
    enabled: !!projectId,
    refetchInterval: 30_000,
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

/** Start connecting GitHub through the instance's App. Deliberately NOT invalidating anything
 *  on success: nothing is recorded until GitHub redirects back through the
 *  callback, so a refetch here would only re-read the same list. */
export function useGitHubConnect(projectId: string | undefined) {
  return useMutation({
    mutationFn: (params: { returnTo?: "integrations" }) =>
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

/** Mint a new inbound secret for a binding; the result carries it this once. */
export function useRotateIntegrationSecret(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  return useMutation({
    mutationFn: (id: string) => integrationsApi.rotateSecret(projectId as string, id),
    onSettled: () => invalidate(),
  });
}

/**
 * Create a connection and its binding in one call: into this project, and into every project an
 * {@link useAlsoBind} provider above names.
 */
export function useCreateProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateBindingChange(projectId);
  const qc = useQueryClient();
  const also = useAlsoBind();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: (body: CreateIntegrationInput) => createIntegration(projectId as string, body, also),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["integration-connections"] });
      if (also.length > 0) void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast({ title: t("integrations.toast.saved"), tone: "success" });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.saveFailed"),
        description: bindingRefusalText(err),
        tone: "error",
      }),
  });
}

/** Patch a Coolify/Epodsystem integration (config/secrets/active). */
export function useUpdateProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateBindingChange(projectId);
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateIntegrationInput }) =>
      updateIntegration(projectId as string, id, body),
    onSuccess: () => {
      invalidate();
      toast({ title: t("integrations.toast.saved"), tone: "success" });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.saveFailed"),
        description: bindingRefusalText(err),
        tone: "error",
      }),
  });
}

/** Delete a Coolify/Epodsystem integration (provider-neutral toast copy). */
export function useDeleteProviderIntegration(projectId: string | undefined) {
  const invalidate = useInvalidateBindingChange(projectId);
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: (binding: Pick<IntegrationSummary, "id" | "revision">) =>
      integrationsApi.remove(projectId as string, binding),
    onSuccess: () => {
      invalidate();
      toast({ title: t("integrations.toast.removed"), tone: "success" });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.removeFailed"),
        description: formatApiError(err),
        tone: "error",
      }),
  });
}


/** Release the production deploy gate for an in-flight pipeline run. */
export function useConfirmProdDeploy(projectId: string | undefined) {
  const invalidate = useInvalidateIntegrations(projectId);
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: (id: string) =>
      integrationsApi.confirmProdDeploy(projectId as string, id),
    onSuccess: (res) => {
      invalidate();
      toast({
        title: res.confirmed ? t("integrations.toast.liveConfirmed") : t("integrations.toast.nothingToConfirm"),
        tone: res.confirmed ? "success" : "info",
      });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.confirmFailed"),
        description: formatApiError(err),
        tone: "error",
      }),
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

/**
 * UX mirror of the server's org-permission rule: config/secret/active changes
 * on a binding backed by an ORG-owned connection require org owner/admin of
 * that org (the connection's org == the project's org — the server enforces
 * same-org binding). Returns true when the provider section should disable its
 * Save/Rotate buttons + secret inputs. Fails OPEN (false) while either query
 * is still loading — the server 403s regardless, this is purely affordance.
 */
export function useIsOrgAdmin(projectId: string | undefined): boolean {
  const projectsQ = useProjects();
  if (!projectId) return false;
  const orgRole = projectsQ.data?.find((p) => p.id === projectId)?.orgRole ?? null;
  return orgRole === "owner" || orgRole === "admin";
}

export function useOrgConnectionLocked(
  projectId: string | undefined,
  connectionId: string | null | undefined,
): boolean {
  const connectionsQ = useConnections();
  const projectsQ = useProjects();
  if (!projectId || !connectionId) return false;
  const connection = connectionsQ.data?.items.find(
    (c) => c.id === connectionId,
  );
  if (connection?.ownerType !== "org") return false;
  const orgRole =
    projectsQ.data?.find((p) => p.id === projectId)?.orgRole ?? null;
  return orgRole !== "owner" && orgRole !== "admin";
}

/**
 * Can the caller MANAGE (rename/key/config/remove) a connection at the
 * workspace directory? UX mirror of the server's `loadManageableConnection`:
 * a user-owned row in the owner-scoped list is always the caller's own; an
 * org-owned row needs org owner/admin (resolved from the orgs list, since the
 * directory has no project context — contrast `useOrgConnectionLocked`).
 * Fails closed while orgs load; the server 403s regardless.
 */
export function useCanManageConnection(
  connection: { ownerType: string; ownerId: string } | null,
): boolean {
  const orgsQ = useOrgs();
  if (!connection) return false;
  if (connection.ownerType === "user") return true;
  const role = orgsQ.data?.find((o) => o.id === connection.ownerId)?.role;
  return isOrgAdmin(role);
}

function useInvalidateConnections() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["integration-connections"] });
    void qc.invalidateQueries({ queryKey: ["integrations"] });
  };
}

/** Patch a connection (displayName/config/secrets/active). */
export function useUpdateConnection() {
  const invalidate = useInvalidateConnections();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ConnectionUpdateInput }) =>
      integrationConnectionsApi.update(id, body),
    onSuccess: () => {
      invalidate();
      toast({ title: t("integrations.toast.connectionSaved"), tone: "success" });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.connectionSaveFailed"),
        description: formatApiError(err),
        tone: "error",
      }),
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
  const t = useCopy();
  return useMutation({
    mutationFn: integrationConnectionsApi.remove,
    onSuccess: () => {
      invalidate();
      toast({ title: t("integrations.toast.connectionRemoved"), tone: "success" });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.connectionRemoveFailed"),
        description: formatApiError(err),
        tone: "error",
      }),
  });
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

/** What a connection can be bound to, as binding-v1 targets. */
export function useConnectionTargets(connectionId: string | null | undefined) {
  return useQuery({
    queryKey: ["integration-connections", connectionId, "targets"],
    queryFn: () => integrationConnectionsApi.targets(connectionId as string),
    enabled: !!connectionId,
    retry: false,
  });
}

/** Bind one connection into several projects, each with its own target, as one write. */
export function useBindConnectionInto(connectionId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: (items: ConnectionBindingItem[]) => bindConnectionInto(connectionId, items),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["integration-connections"] });
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast({ title: t("integrations.toast.bound"), tone: "success" });
    },
  });
}

export function useBindConnection(projectId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = useInvalidateBindingChange(projectId);
  const { toast } = useToast();
  const t = useCopy();
  return useMutation({
    mutationFn: (input: BindConnectionInput) => bindConnection(projectId as string, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["integration-connections"] });
      invalidate();
      toast({ title: t("integrations.toast.bound"), tone: "success" });
    },
    onError: (err) =>
      toast({
        title: t("integrations.toast.bindFailed"),
        description: bindingRefusalText(err),
        tone: "error",
      }),
  });
}
