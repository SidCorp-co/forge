"use client";

import { Button } from "@/design";
import type { AgentPathKind } from "@forge/contracts";
import { useMemo, useState } from "react";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl,
  agentAccessBody,
  agentAccessDeniedReason,
  mayWriteAgentAccess,
} from "../components/agent-access-control";
import { IntegrationEnabledControl } from "../components/integration-enabled-control";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useIsOrgAdmin,
  useOrgConnectionLocked,
  useUpdateProviderIntegration,
} from "../hooks";
import type { AgentAccess, IntegrationSummary } from "../types";
import { useBindingTest } from "./shared";

type Provider = { provider: string; agentPathKind: AgentPathKind };

/**
 * One binding of a provider on the project, edited through a form seeded from it: the state a
 * single-binding provider section shares.
 */
export function useSingleBinding<F>(
  projectId: string,
  module: Provider,
  initialForm: (existing: IntegrationSummary | undefined) => F,
) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === module.provider),
    [list.data, module.provider],
  );
  const create = useCreateProviderIntegration(projectId);
  const update = useUpdateProviderIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const test = useBindingTest(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [form, setForm] = useState<F>(() => initialForm(existing));
  const [seededFor, setSeededFor] = useState<string | null>(existing?.id ?? null);
  if ((existing?.id ?? null) !== seededFor) {
    setForm(initialForm(existing));
    setSeededFor(existing?.id ?? null);
  }
  const set = <K extends keyof F>(key: K, value: F[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Write `config` and, when typed, the secret: onto the binding, or as a new one. */
  async function save(config: Record<string, unknown>, [key, secret]: [string, string]) {
    if (existing) {
      await update.mutateAsync({ id: existing.id, body: { config, ...(secret ? { secrets: { [key]: secret } } : {}) } });
    } else {
      await create.mutateAsync({
        provider: module.provider,
        role: "service",
        config,
        secrets: { [key]: secret },
        ...agentAccessBody(module.agentPathKind, agentAccess),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
    }
  }

  return {
    projectId,
    pathKind: module.agentPathKind,
    existing,
    remove,
    test,
    save,
    ownerOrgId,
    setOwnerOrgId,
    agentAccess,
    setAgentAccess,
    form,
    set,
    saving: create.isPending || update.isPending,
    orgLocked: useOrgConnectionLocked(projectId, existing?.connectionId),
    isOrgAdmin: useIsOrgAdmin(projectId),
  };
}

/**
 * The agent grant (a saved binding writes it, a connect form holds it until create), then Save /
 * Test on the left and Enabled / Remove on the right.
 */
export function SingleBindingFooter({
  b,
  canSave,
  onSave,
}: {
  b: Omit<ReturnType<typeof useSingleBinding<unknown>>, "form" | "set">;
  canSave: boolean;
  onSave: () => void;
}) {
  const { projectId, existing, pathKind } = b;
  const disabledReason = agentAccessDeniedReason(pathKind);
  return (
    <>
      {existing ? (
        <AgentAccessControl projectId={projectId} binding={existing} canEdit disabledReason={disabledReason} />
      ) : (
        <AgentAccessChoice
          value={b.agentAccess}
          onChange={b.setAgentAccess}
          pathKind={pathKind}
          canEdit={mayWriteAgentAccess(pathKind, { canEditProject: true, isOrgAdmin: b.isOrgAdmin })}
          disabledReason={disabledReason}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={onSave} loading={b.saving} disabled={!canSave}>
            {existing ? "Save" : "Create integration"}
          </Button>
          {existing && (
            <Button variant="secondary" onClick={() => b.test.run(existing.id)} loading={b.test.pending}>
              Test connection
            </Button>
          )}
        </div>
        {existing && (
          <div className="flex items-center gap-4">
            <IntegrationEnabledControl projectId={projectId} binding={existing} />
            <Button variant="danger" icon="trash" loading={b.remove.isPending} onClick={() => b.remove.mutate(existing)}>
              Remove
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
