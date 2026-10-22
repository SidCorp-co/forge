"use client";

import { Button, Toggle } from "@/design";
import {
  useOrgConnectionLocked,
  useUpdateConnection,
  useUpdateProviderIntegration,
} from "../hooks";
import { providerModule } from "../providers/registry";
import type { IntegrationSummary } from "../types";

/** A binding over a connection a remove left switched off and keyless (ISS-1421 r22). */
export function bindsRemovedConnection(
  binding: Pick<IntegrationSummary, "connectionActive" | "hasSecrets">,
): boolean {
  return !binding.connectionActive && !binding.hasSecrets;
}

/** What turns a removed shared connection back on, said where the project's binding names it. */
export function removedCredentialLine(provider: string): string {
  const module = providerModule(provider);
  if (module?.secretField !== null) {
    return "The shared connection was removed, so it holds no key. Saving a new key on it under Connections turns it back on.";
  }
  return module.removedLine ?? "The shared connection was removed, so no project can use it.";
}

export function IntegrationEnabledControl({
  projectId,
  binding,
}: {
  projectId: string;
  binding: IntegrationSummary;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const updateConnection = useUpdateConnection();
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);

  const optedIn = binding.bindingActive;
  const credentialDisabled = !binding.connectionActive;
  // A removed connection holds no key, and core refuses to turn it on (ISS-1421 r22): no Enable
  // credential, only what does turn it back on.
  const credentialRemoved = bindsRemovedConnection(binding);

  // A row of its own, the notice below the switch at the drawer's full width: beside the switch it
  // was squeezed to about a word a line at 390 (ISS-1421 r12).
  return (
    <div className="flex w-full flex-col gap-2">
      <span className="flex items-center gap-2">
        <span className="fg-body-sm text-muted">Enabled</span>
        <Toggle
          aria-label="Enabled for this project"
          checked={optedIn}
          onChange={(active) =>
            update.mutate({ id: binding.id, body: { active } })
          }
          disabled={orgLocked}
        />
      </span>
      {credentialRemoved && (
        <span className="fg-body-sm text-amber">{removedCredentialLine(binding.provider)}</span>
      )}
      {credentialDisabled && !credentialRemoved && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="fg-body-sm min-w-0 flex-1 basis-48 text-amber">
            Shared credential is disabled — no project can use it.
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={orgLocked}
            loading={updateConnection.isPending}
            onClick={() =>
              updateConnection.mutate({
                id: binding.connectionId,
                body: { active: true },
              })
            }
          >
            Enable credential
          </Button>
        </div>
      )}
    </div>
  );
}
