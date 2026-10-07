"use client";

import { Banner, Button } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** Forge reads each deploy's outcome back from Coolify; nothing in Coolify to configure. */
export function DeployConfirmationHint() {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">{t("integrations.coolify.confirmation")}</span>
      <span className="fg-body-sm">{t("integrations.coolify.confirmationBody")}</span>
      <span className="fg-body-sm text-subtle">{t("integrations.coolify.confirmationTimeout")}</span>
    </div>
  );
}

/**
 * The production approval gate. Whether a release deploys to production without it is the
 * project document's production environment (`deployment.trigger: "on-land"`), not a switch here.
 */
export function ProdGateSection({
  integrationId,
  confirmPending,
  onConfirm,
}: {
  integrationId: string;
  confirmPending: boolean;
  onConfirm: () => void;
}) {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
        <span className="fg-label text-subtle">{t("integrations.coolify.gate")}</span>
        <span className="fg-body-sm text-muted">
          {t("integrations.coolify.gateBody.lead")} (<code>deployment.trigger: &quot;on-land&quot;</code>).{" "}
          {t("integrations.coolify.gateBody.tail")}
        </span>
      </div>
      <Banner tone="attention">
        <div className="flex flex-col gap-2">
          <span className="fg-label">{t("integrations.coolify.gate")}</span>
          <span className="fg-body-sm">{t("integrations.coolify.gateNever")}</span>
          <div>
            <Button size="sm" loading={confirmPending} onClick={onConfirm}>
              {t("integrations.coolify.confirmLive")}
            </Button>
          </div>
          <span className="font-mono text-10 text-subtle">{t("integrations.coolify.integrationId", { id: integrationId })}</span>
        </div>
      </Banner>
    </div>
  );
}
