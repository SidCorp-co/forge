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

/** When a provider's MCP tools reach agents: every switch between them and the agent, named as the
 *  drawer labels it, so no drawer introduction leaves one out (ISS-1421 r12). */
export function reachesAgentsWhile(tools: string): string {
  return `${tools} reach this project's agents only while its shared credential, Enabled and the grant below are all on.`;
}

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

/** Which tier turned a binding off: this project's Enabled switch, the shared credential, or both. */
export type TurnedOff = "binding" | "credential" | "both";

/** Where the switch is read from: inside the provider's drawer, or the Agent MCP servers panel. */
export type ReadFrom = "drawer" | "panel";

const OFF = "Agents get nothing from it while it is turned off.";

/** Each control that turns it back on, named as its drawer labels it, and where it is (ISS-1421 r11, r12). */
function backOn(tier: TurnedOff, from: ReadFrom): string {
  const where = from === "drawer" ? "in this drawer" : "in its drawer, opened from the list above,";
  if (tier === "both") {
    const both = from === "drawer" ? "both in this drawer" : "both in its drawer, opened from the list above";
    return `once you press Enable credential and switch Enabled back on, ${both}`;
  }
  return tier === "binding"
    ? `once Enabled ${where} is switched back on`
    : `once Enable credential ${where} turns its shared credential back on`;
}

/** A binding turned off gives agents nothing, granted or not, so nothing under the switch may read
 *  as live (ISS-1421 r10, criterion 134), and the way back names its switch and where it is. */
export function turnedOffCopy(tier: TurnedOff, from: ReadFrom): { granted: string; withheld: string } {
  return {
    granted: `${OFF} They may use it ${backOn(tier, from)}.`,
    withheld: `${OFF} A grant takes effect ${backOn(tier, from)}.`,
  };
}

/** The tier a saved binding is turned off at, or null where both are on. */
export function turnedOffTier(
  binding: Pick<IntegrationSummary, "active" | "bindingActive" | "connectionActive">,
): TurnedOff | null {
  if (binding.active) return null;
  if (binding.bindingActive) return "credential";
  return binding.connectionActive ? "binding" : "both";
}

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
    ? "Granting this sends the integration's credential to the runner, so only an organization owner or admin can grant it."
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
  turnedOff = null,
  readFrom = "drawer",
}: {
  value: AgentAccess;
  onChange: (next: AgentAccess) => void;
  pathKind: AgentPathKind;
  canEdit: boolean;
  /** Who may change it, shown whenever `canEdit` is false. */
  disabledReason?: string;
  busy?: boolean;
  failure?: string | null;
  /** A saved binding that is turned off: what the grant would do is not what happens now. */
  turnedOff?: TurnedOff | null;
  readFrom?: ReadFrom;
}) {
  const kind = pathKind === "none" ? undefined : KIND_COPY[pathKind];
  const copy = kind && turnedOff ? turnedOffCopy(turnedOff, readFrom) : kind;
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
  readFrom = "drawer",
}: {
  projectId: string;
  binding: Pick<
    IntegrationSummary,
    "id" | "agentAccess" | "agentPathKind" | "active" | "bindingActive" | "connectionActive"
  >;
  /** May the caller edit this project's integrations at all. The GRANT's own tier is applied here. */
  canEdit: boolean;
  disabledReason?: string;
  readFrom?: ReadFrom;
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
      turnedOff={turnedOffTier(binding)}
      readFrom={readFrom}
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
