"use client";

import { Banner, Collapsible, EmptyState, ErrorState, Icon, type IconName, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useIntegrationDeliveries } from "../hooks";
import { redactSensitive } from "../derive";
import type { IntegrationDelivery } from "../types";

/** Read-only audit of recent webhook/dispatch deliveries for one binding
 *  (ISS-402). Render ONLY when the provider's `capabilities.hasDeliveryLog` is
 *  true — MCP-injection providers (postman/epodsystem) must not show an empty
 *  box, so the caller gates this component. No retry affordance: there is no
 *  backend replay route (deferred to ISS-404/F). */

const STATUS_META: Record<IntegrationDelivery["status"], { icon: IconName; fg: string; label: string }> = {
  ok: { icon: "check", fg: "var(--green-600)", label: "ok" },
  failed: { icon: "alert", fg: "var(--red-600)", label: "failed" },
  pending: { icon: "clock", fg: "var(--amberw-600)", label: "pending" },
};

function DeliveryRow({ row }: { row: IntegrationDelivery }) {
  const s = STATUS_META[row.status] ?? STATUS_META.pending;
  const dirIcon: IconName = row.direction === "inbound" ? "inbox" : "arrowRight";
  const duration = typeof row.durationMs === "number" ? `${row.durationMs}ms` : "—";

  return (
    <Collapsible
      title={
        <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Icon name={dirIcon} size={13} />
            <span className="fg-body-sm">{row.direction}</span>
          </span>
          <span className="font-mono text-[12px] text-fg">{row.eventName}</span>
          <span className="inline-flex items-center gap-1 font-semibold" style={{ color: s.fg }}>
            <Icon name={s.icon} size={13} />
            {s.label}
          </span>
          <span className="ml-auto inline-flex items-center gap-3 text-subtle">
            <span className="fg-body-sm">{duration}</span>
            <span className="fg-body-sm">{formatRelativeTime(row.createdAt, { emptyLabel: "—" })}</span>
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {row.errorMessage && <Banner tone="danger">{row.errorMessage}</Banner>}
        <div>
          <span className="fg-overline text-subtle">Payload</span>
          <pre className="mt-1 overflow-x-auto rounded bg-sunken p-2 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(redactSensitive(row.payload), null, 2)}
          </pre>
        </div>
        {row.response && (
          <div>
            <span className="fg-overline text-subtle">Response</span>
            <pre className="mt-1 overflow-x-auto rounded bg-sunken p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(redactSensitive(row.response), null, 2)}
            </pre>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

export function DeliveryLogViewer({
  projectId,
  bindingId,
}: {
  projectId: string;
  bindingId: string | null;
}) {
  const deliveries = useIntegrationDeliveries(projectId, bindingId);

  if (!bindingId) {
    return (
      <EmptyState
        title="No deliveries"
        message="Save this integration to start recording deliveries."
        mascot={false}
      />
    );
  }
  if (deliveries.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[44px] w-full" />
        ))}
      </div>
    );
  }
  if (deliveries.isError) {
    return <ErrorState message={formatApiError(deliveries.error)} onRetry={() => deliveries.refetch()} />;
  }

  const items = deliveries.data?.items ?? [];
  if (items.length === 0) {
    return <EmptyState title="No deliveries yet" message="Nothing has been dispatched or received." mascot={false} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((row) => (
        <DeliveryRow key={row.id} row={row} />
      ))}
    </div>
  );
}
