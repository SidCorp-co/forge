import { Banner, Button } from "@/design";

/** Forge reads each deploy's outcome back from Coolify; nothing in Coolify to configure. */
export function DeployConfirmationHint() {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Deploy confirmation</span>
      <span className="fg-body-sm">
        Forge reads each deploy&apos;s outcome back from Coolify and holds the pipeline run open until every
        target reports. Nothing to configure in Coolify — it sends no callback, so Forge asks instead.
      </span>
      <span className="fg-body-sm text-subtle">A deploy still unconfirmed after 30 minutes fails its run.</span>
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
        <span className="fg-label text-subtle">Live approval gate</span>
        <span className="fg-body-sm text-muted">
          Where this binding reaches production — it is the binding the production environment names, or
          deploys to an application that one does — a production deploy waits for the confirmation below
          unless that environment deploys on land (<code>deployment.trigger: &quot;on-land&quot;</code>).
          Confirming any other binding is refused.
        </span>
      </div>
      <Banner tone="attention">
        <div className="flex flex-col gap-2">
          <span className="fg-label">Live approval gate</span>
          <span className="fg-body-sm">
            Live deploys never auto-dispatch. Click confirm when ready to release the gate for an in-flight
            pipeline run.
          </span>
          <div>
            <Button size="sm" loading={confirmPending} onClick={onConfirm}>
              Confirm live deploy
            </Button>
          </div>
          <span className="font-mono text-10 text-subtle">integration: {integrationId}</span>
        </div>
      </Banner>
    </div>
  );
}
