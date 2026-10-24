"use client";

import { Button, Toggle } from "@/design";
import {
  connectionManagers,
  useConnectionManager,
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

/**
 * What turns a removed shared connection back on, said where the project's binding names it. A reader
 * whose key save core would refuse is told who may save one rather than to save it (ISS-1421 r25).
 */
export function removedCredentialLine(provider: string, keyLocked: boolean): string {
  const module = providerModule(provider);
  if (module?.secretField !== null) {
    return keyLocked
      ? "The shared connection was removed, so it holds no key. Only an owner or admin of the organization that owns it can save a new key on it, which turns it back on."
      : "The shared connection was removed, so it holds no key. Saving a new key in this drawer turns it back on.";
  }
  return module.removedLine ?? "The shared connection was removed, so no project can use it.";
}

/** The key field's hint over a removed connection, asking for a key only of a reader who may save one. */
export function removedKeyHint(noun: "key" | "token", keyLocked: boolean): string {
  const said = `No ${noun} is stored: the shared connection was removed.`;
  return keyLocked ? said : `${said} Enter one to store it.`;
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
  const manager = useConnectionManager(binding.connectionId);

  const optedIn = binding.bindingActive;
  const credentialDisabled = !binding.connectionActive;
  // A removed connection holds no key, and core refuses to turn it on (ISS-1421 r22): no Enable
  // credential, only what does turn it back on. A key saved here turns it on (r26).
  const credentialRemoved = bindsRemovedConnection(binding);

  // A row of its own, the notice below the switch at the drawer's full width: beside the switch it
  // was squeezed to about a word a line at 390 (ISS-1421 r12).
  return (
    <div className="flex w-full flex-col gap-2">
      <span className="flex items-center gap-2">
        <span className="fg-body-sm text-muted">Enabled</span>
        {/* The binding's own tier, a project admin's on an organization's connection too (ISS-1115);
            it was still locked to the organization's admins, so "Enabled switches it back on" was
            false for the rest (ISS-1421 r26). */}
        <Toggle
          aria-label="Enabled for this project"
          checked={optedIn}
          onChange={(active) =>
            update.mutate({ id: binding.id, body: { active } })
          }
          disabled={credentialRemoved && !optedIn}
        />
      </span>
      {credentialRemoved && (
        <span className="fg-body-sm text-amber">{removedCredentialLine(binding.provider, orgLocked)}</span>
      )}
      {credentialDisabled && !credentialRemoved && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="fg-body-sm min-w-0 flex-1 basis-48 text-amber">
            Shared credential is disabled — no project can use it.
            {/* Enable credential was offered to a reader the connection's routes refuse (ISS-1421 r26). */}
            {manager && !manager.manages && ` Only ${connectionManagers(manager.ownerType)} can turn it back on.`}
          </span>
          {manager?.manages && (
            <Button
              variant="secondary"
              size="sm"
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
          )}
        </div>
      )}
    </div>
  );
}
