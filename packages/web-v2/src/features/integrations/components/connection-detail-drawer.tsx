"use client";

import { useMemo, useState } from "react";
import { Icon, SegmentedControl, SlideOver, Tabs } from "@/design";
import { useIntegrationsList } from "../hooks";
import { DIRECTORY_STATUS_META, deriveDirectoryStatus, getCapabilities } from "../derive";
import type { DrillableProvider } from "../derive";
import type { IntegrationEnvironment, StatusCard } from "../types";
import { CoolifySection } from "./coolify-section";
import { DeliveryLogViewer } from "./delivery-log-viewer";
import { EpodsystemSection } from "./epodsystem-section";
import { PostmanSection } from "./postman-section";

/** Adaptive connection detail (ISS-402). Opened from a directory provider card;
 *  renders the provider's existing config+actions section (Test / Rotate /
 *  Disconnect) and — ONLY when the adapter declares `hasDeliveryLog` — a
 *  read-only delivery-log tab. The env split (staging/prod) shows only when
 *  `hasEnvironments`. MCP-injection providers therefore get a single config
 *  pane with no empty delivery-log box. */

const PROVIDER_LABEL: Record<DrillableProvider, string> = {
  coolify: "Coolify deploy",
  postman: "Postman",
  epodsystem: "Epodsystem",
};

const ENV_OPTIONS: { value: IntegrationEnvironment; label: string }[] = [
  { value: "staging", label: "Staging" },
  { value: "prod", label: "Production" },
];

function StatusPill({ card }: { card: StatusCard }) {
  const m = DIRECTORY_STATUS_META[deriveDirectoryStatus(card)];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[12px] font-semibold"
      style={{ color: m.fg, background: m.bg }}
    >
      <Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

function ProviderSection({ provider, projectId }: { provider: DrillableProvider; projectId: string }) {
  if (provider === "coolify") return <CoolifySection projectId={projectId} />;
  if (provider === "postman") return <PostmanSection projectId={projectId} />;
  return <EpodsystemSection projectId={projectId} />;
}

function DeliveryLogPane({
  provider,
  projectId,
  hasEnvironments,
}: {
  provider: DrillableProvider;
  projectId: string;
  hasEnvironments: boolean;
}) {
  const [env, setEnv] = useState<IntegrationEnvironment>("staging");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === provider),
    [list.data, provider],
  );
  // hasEnvironments providers can carry one binding per environment; otherwise
  // there is a single binding for the provider.
  const binding = hasEnvironments ? rows.find((r) => r.environment === env) : rows[0];

  return (
    <div className="flex flex-col gap-3">
      {hasEnvironments && (
        <SegmentedControl<IntegrationEnvironment> value={env} onChange={setEnv} options={ENV_OPTIONS} />
      )}
      <DeliveryLogViewer projectId={projectId} bindingId={binding?.id ?? null} />
    </div>
  );
}

export function ConnectionDetailDrawer({
  projectId,
  card,
  onClose,
}: {
  projectId: string;
  card: StatusCard | null;
  onClose: () => void;
}) {
  const provider = card ? (card.key.split(":")[0] as DrillableProvider) : null;
  const caps = getCapabilities(card);
  const [tab, setTab] = useState<"config" | "deliveries">("config");

  if (!card || !provider) return null;

  const title = (
    <span className="flex items-center gap-2.5">
      <span>{PROVIDER_LABEL[provider] ?? card.label}</span>
      <StatusPill card={card} />
    </span>
  );

  return (
    <SlideOver open={Boolean(card)} onClose={onClose} title={title} width={560}>
      <div className="flex flex-col gap-4 px-5 py-4">
        {caps.hasDeliveryLog ? (
          <>
            <Tabs
              tabs={[
                { value: "config", label: "Configuration" },
                { value: "deliveries", label: "Delivery log" },
              ]}
              value={tab}
              onChange={(v) => setTab(v as "config" | "deliveries")}
            />
            {tab === "config" ? (
              <ProviderSection provider={provider} projectId={projectId} />
            ) : (
              <DeliveryLogPane
                provider={provider}
                projectId={projectId}
                hasEnvironments={caps.hasEnvironments}
              />
            )}
          </>
        ) : (
          <ProviderSection provider={provider} projectId={projectId} />
        )}
      </div>
    </SlideOver>
  );
}
