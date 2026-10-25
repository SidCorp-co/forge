"use client";

import { Button, Toggle } from "@/design";
import { useUpdateConnection, useUpdateProviderIntegration } from "../hooks";
import { providerModule } from "../providers/registry";
import type { BindingActs, IntegrationSummary } from "../types";

/** A binding over a connection a remove left switched off and keyless (ISS-1421 r22). */
export function bindsRemovedConnection(
  binding: Pick<IntegrationSummary, "connectionActive" | "hasSecrets">,
): boolean {
  return !binding.connectionActive && !binding.hasSecrets;
}

/** "Only …", from a binding act's `who`. */
export const onlyWho = (who: string): string => `Only ${who}`;

/** What turns a removed shared connection back on; a reader core would refuse a key save is told who
 *  may save one, read off the binding's acts (ISS-1421 r25, r27). */
export function removedCredentialLine(
  provider: string,
  acts: Pick<BindingActs, "saveKey" | "whoSavesKey">,
): string {
  const module = providerModule(provider);
  if (module?.secretField !== null) {
    return acts.saveKey
      ? "The shared connection was removed, so it holds no key. Saving a new key in this drawer turns it back on."
      : `The shared connection was removed, so it holds no key. ${onlyWho(acts.whoSavesKey)} can save a new key on it, which turns it back on.`;
  }
  return module.removedLine ?? "The shared connection was removed, so no project can use it.";
}

/** The key field's hint over a removed connection, asking for a key only of a reader who may save one. */
export function removedKeyHint(noun: "key" | "token", acts: Pick<BindingActs, "saveKey">): string {
  const said = `No ${noun} is stored: the shared connection was removed.`;
  return acts.saveKey ? `${said} Enter one to store it.` : said;
}

/** Who may change the key and shared settings a drawer withholds (ISS-1421 r27). */
export function keyLockedLine(acts: Pick<BindingActs, "whoSavesKey">): string {
  return `${onlyWho(acts.whoSavesKey)} can change this connection's key or shared settings.`;
}

/** Who may use the binding's own controls a drawer withholds. */
export function bindingLockedLine(acts: Pick<BindingActs, "whoChanges">): string {
  return `${onlyWho(acts.whoChanges)} can switch this integration, change its settings here or disconnect it.`;
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
  const { acts } = binding;

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
        {/* The binding's own tier: a project admin's, on an organization's connection too (ISS-1115). */}
        <Toggle
          aria-label="Enabled for this project"
          checked={optedIn}
          onChange={(active) =>
            update.mutate({ id: binding.id, body: { active } })
          }
          disabled={!acts.change || (credentialRemoved && !optedIn)}
        />
      </span>
      {!acts.change && <span className="fg-body-sm text-muted">{bindingLockedLine(acts)}</span>}
      {credentialRemoved && (
        <span className="fg-body-sm text-amber">{removedCredentialLine(binding.provider, acts)}</span>
      )}
      {credentialDisabled && !credentialRemoved && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="fg-body-sm min-w-0 flex-1 basis-48 text-amber">
            Shared credential is disabled — no project can use it.
            {/* Enable credential was offered to a reader the connection's routes refuse (ISS-1421 r26). */}
            {!acts.turnOn && ` ${onlyWho(acts.whoTurnsOn)} can turn it back on.`}
          </span>
          {acts.turnOn && (
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
