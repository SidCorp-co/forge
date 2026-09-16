"use client";

import { Button, Toggle } from "@/design";
import {
  useOrgConnectionLocked,
  useUpdateConnection,
  useUpdateProviderIntegration,
} from "../hooks";
import type { IntegrationSummary } from "../types";

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

  return (
    <div className="flex items-center gap-3">
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
      {credentialDisabled && (
        <div className="flex items-center gap-2">
          <span className="fg-body-sm text-amber">
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
