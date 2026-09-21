"use client";


import { useState } from "react";
import type { AgentAccess, AgentPathKind } from "@forge/contracts";
import { Toggle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useIsOrgAdmin, useUpdateProviderIntegration } from "../hooks";
import type { IntegrationSummary } from "../types";

/** The closed answer, and what a binding gets for not choosing. */
export const AGENT_ACCESS_CLOSED: AgentAccess = "none";

export const GRANT_LABEL = "Agents on this project may use this";

const KIND_COPY: Record<
  Exclude<AgentPathKind, "none">,
  { granted: string; withheld: string }
> = {
  "direct-mcp": {
    granted:
      "This project's credential is handed to the runner box, and the agent calls the provider directly. Forge is outside that call path: it does not see the calls and cannot stop one.",
    withheld:
      "Granting this hands the project's credential to the runner box, and the agent then calls the provider directly. Forge is outside that call path: it does not see the calls and cannot stop one.",
  },
  "core-mediated": {
    granted: "Forge holds the credential and makes the call on the agent's behalf.",
    withheld:
      "Granting this lets the agent ask Forge to call the provider. Forge holds the credential and makes the call; the agent never receives it.",
  },
};

export function agentAccessBody(
  pathKind: AgentPathKind,
  value: AgentAccess,
): { agentAccess?: AgentAccess } {
  return pathKind === "none" ? {} : { agentAccess: value };
}

export function mayWriteAgentAccess(
  pathKind: AgentPathKind,
  perms: { canEditProject: boolean; isOrgAdmin: boolean },
): boolean {
  if (pathKind === "none") return false;
  if (!perms.canEditProject) return false;
  return pathKind === "direct-mcp" ? perms.isOrgAdmin : true;
}

/** Who the caller has to be, said in the same terms the server refuses in. */
export function agentAccessDeniedReason(pathKind: AgentPathKind): string {
  return pathKind === "direct-mcp"
    ? "This integration's credential is sent to the runner, so only an organisation owner or admin can grant it to agents."
    : "Only a project admin can change this.";
}

/**
 * The control itself, with no opinion about where the value is stored — the connect forms drive it
 * from their own state, the binding rows drive it from a PATCH.
 *
 * Renders NOTHING when `pathKind` is `none`: that provider has no agent path, so the column is inert
 * and offering a switch would promise a thing granting it cannot do.
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
  disabledReason?: string;
  busy?: boolean;
  failure?: string | null;
}) {
  const copy = pathKind === "none" ? undefined : KIND_COPY[pathKind];
  if (!copy) return null;

  const granted = value !== AGENT_ACCESS_CLOSED;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <Toggle
          aria-label={GRANT_LABEL}
          checked={granted}
          onChange={(next) => onChange(next ? "all" : AGENT_ACCESS_CLOSED)}
          disabled={!canEdit || busy === true}
        />
        <span className="fg-body-sm text-fg">{GRANT_LABEL}</span>
      </span>
      <p className="fg-body-sm text-muted">{granted ? copy.granted : copy.withheld}</p>
      {!canEdit && (
        <p className="fg-body-sm text-subtle">
          {disabledReason ?? "Only a project admin can change this."}
        </p>
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
  disabledReason?: string;
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
