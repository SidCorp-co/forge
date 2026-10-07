"use client";

import { Button, Toggle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
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
  const t = useCopy();

  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-2">
        <span className="fg-body-sm text-muted">{t("integrations.enabled")}</span>
        <Toggle
          aria-label={t("integrations.enabled.label")}
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
            {t("integrations.enabled.credentialOff")}
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
            {t("integrations.enabled.enableCredential")}
          </Button>
        </div>
      )}
    </div>
  );
}
