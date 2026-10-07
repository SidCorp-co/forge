"use client";


import { useState } from "react";
import type { AgentAccess, AgentPathKind } from "@forge/contracts/integrations";
import { Toggle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useIsOrgAdmin, useUpdateProviderIntegration } from "../hooks";
import type { IntegrationSummary } from "../types";

/** The closed answer, and what a binding gets for not choosing. */
export const AGENT_ACCESS_CLOSED: AgentAccess = "none";


/** The agent paths a binding grant applies to; `none` has no agent path and `permission` is decided by a project permission. */
type GrantedPathKind = Exclude<AgentPathKind, "none" | "permission">;

const takesGrant = (pathKind: AgentPathKind): pathKind is GrantedPathKind =>
  pathKind === "direct-mcp" || pathKind === "core-mediated";

const KIND_COPY: Record<GrantedPathKind, { granted: ProductCopyKey; withheld: ProductCopyKey }> = {
  "direct-mcp": { granted: "integrations.access.directGranted", withheld: "integrations.access.directWithheld" },
  "core-mediated": { granted: "integrations.access.coreGranted", withheld: "integrations.access.coreWithheld" },
};

export function agentAccessBody(
  pathKind: AgentPathKind,
  value: AgentAccess,
): { agentAccess?: AgentAccess } {
  return takesGrant(pathKind) ? { agentAccess: value } : {};
}

export function mayWriteAgentAccess(
  pathKind: AgentPathKind,
  perms: { canEditProject: boolean; isOrgAdmin: boolean },
): boolean {
  if (!takesGrant(pathKind)) return false;
  if (!perms.canEditProject) return false;
  return pathKind === "direct-mcp" ? perms.isOrgAdmin : true;
}

/** Who the caller has to be, said in the same terms the server refuses in, as a copy key. */
export function agentAccessDeniedReason(pathKind: AgentPathKind): ProductCopyKey {
  return pathKind === "direct-mcp" ? "integrations.access.deniedDirect" : "integrations.access.deniedProject";
}

/**
 * The control itself, with no opinion about where the value is stored — the connect forms drive it
 * from their own state, the binding rows drive it from a PATCH.
 *
 * Renders NOTHING when the provider takes no grant: with no agent path the column is inert, and on a
 * `permission` path the project permission alone decides, so a switch would promise what it cannot do.
 */
export function AgentAccessChoice({
  value,
  onChange,
  pathKind,
  canEdit,
  disabledReason,
  busy,
  failure,
}: {
  value: AgentAccess;
  onChange: (next: AgentAccess) => void;
  pathKind: AgentPathKind;
  canEdit: boolean;
  /** Who may change it, shown whenever `canEdit` is false. */
  disabledReason?: ProductCopyKey;
  busy?: boolean;
  failure?: string | null;
}) {
  const t = useCopy();
  const copy = takesGrant(pathKind) ? KIND_COPY[pathKind] : undefined;
  if (!copy) return null;

  const granted = value !== AGENT_ACCESS_CLOSED;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <Toggle
          aria-label={t("integrations.access.grant")}
          checked={granted}
          onChange={(next) => onChange(next ? "all" : AGENT_ACCESS_CLOSED)}
          disabled={!canEdit || busy === true}
        />
        <span className="fg-body-sm text-fg">{t("integrations.access.grant")}</span>
      </span>
      <p className="fg-body-sm text-muted">{t(granted ? copy.granted : copy.withheld)}</p>
      {!canEdit && (
        <p className="fg-body-sm text-subtle">{t(disabledReason ?? "integrations.access.deniedProject")}</p>
      )}
      {failure && <p className="fg-body-sm text-[var(--red-600)]">{failure}</p>}
    </div>
  );
}

/**
 * The same control bound to a saved binding, writing the grant with the binding PATCH.
 *
 * The rendered value is the binding's own `agentAccess` plus, while a write is in flight, the value
 * asked for. A refused write drops the in-flight value, so the row goes back to the last state the
 * server confirmed rather than showing an answer nobody stored.
 */
export function AgentAccessControl({
  projectId,
  binding,
  canEdit,
  disabledReason,
}: {
  projectId: string;
  binding: Pick<IntegrationSummary, "id" | "agentAccess" | "agentPathKind">;
  /** May the caller edit this project's integrations at all. The GRANT's own tier is applied here. */
  canEdit: boolean;
  disabledReason?: ProductCopyKey;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  const [inFlight, setInFlight] = useState<AgentAccess | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // The tier is applied HERE rather than by each caller. A saved binding carries its own
  // `agentPathKind`, so this component has everything the rule needs — and nine call sites deciding
  // it separately is how `mcp-servers-panel` and the connection drawer came to pass plain
  // editability while the provider sections passed a credential lock.
  const mayWrite = mayWriteAgentAccess(binding.agentPathKind, {
    canEditProject: canEdit,
    isOrgAdmin,
  });

  return (
    <AgentAccessChoice
      value={inFlight ?? binding.agentAccess}
      pathKind={binding.agentPathKind}
      canEdit={mayWrite}
      disabledReason={disabledReason ?? agentAccessDeniedReason(binding.agentPathKind)}
      busy={inFlight !== null}
      failure={failure}
      onChange={(next) => {
        setFailure(null);
        setInFlight(next);
        update.mutate(
          { id: binding.id, body: { agentAccess: next } },
          {
            onSuccess: () => setInFlight(null),
            onError: (err) => {
              setInFlight(null);
              setFailure(formatApiError(err));
            },
          },
        );
      }}
    />
  );
}
