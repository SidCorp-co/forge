"use client";

// ISS-1071 — the ONE place a person answers "may agents on this project use this integration".
//
// It replaced a sentinel key in `pipelineConfig.mcpServers`, a different namespace on a different
// settings tab that no connect surface could write. Measured 2026-09-17: 6 of 9 MCP-capable
// bindings on the fleet were active, credentialed and healthy, reached no agent, and rendered as
// "connected · healthy" everywhere in this UI.

import { useState } from "react";
import type { AgentAccess, AgentPathKind } from "@forge/contracts";
import { Toggle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useUpdateProviderIntegration } from "../hooks";
import type { IntegrationSummary } from "../types";

/** The closed answer, and what a binding gets for not choosing. */
export const AGENT_ACCESS_CLOSED: AgentAccess = "none";

export const GRANT_LABEL = "Agents on this project may use this";

// cm:guard the two sentences are not two phrasings of one fact. `direct-mcp` hands the project's
// stored credential to the runner box and the agent calls the provider itself, with Forge outside
// the call path and unable to see or stop the call; `core-mediated` means Forge holds the credential
// and makes the call. A person granting the first is accepting something the second does not ask
// for, so the control must never render one wording for both.
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
  if (pathKind === "none") return null;

  const copy = KIND_COPY[pathKind];
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
  canEdit: boolean;
  disabledReason?: string;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const [inFlight, setInFlight] = useState<AgentAccess | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (binding.agentPathKind === "none") return null;

  return (
    <AgentAccessChoice
      value={inFlight ?? binding.agentAccess}
      pathKind={binding.agentPathKind}
      canEdit={canEdit}
      disabledReason={disabledReason}
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
