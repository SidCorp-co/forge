"use client";

import { enumLabel, FactsGroup, HealthDot, Icon, MonoTag } from "@/design";
import { deviceHealth, useDeviceVersionLabel, useDevices } from "@/features/runners";
import type { SessionRow } from "@/features/sessions";
import { useRailCopy, useRailLanguage } from "../chrome-language";

/** The runner the session is bound to; one outside the viewer's owner-scoped list shows its short id. */
export function RailRunner({ session, deviceId }: { session: SessionRow; deviceId: string }) {
  const t = useRailCopy();
  const language = useRailLanguage();
  const versionLabel = useDeviceVersionLabel();
  const devicesQ = useDevices();
  const device = devicesQ.data?.find((d) => d.id === deviceId);
  const repo = session.repoPath ? (
    <div className="flex items-center gap-2 overflow-hidden">
      <Icon name="folder" size={13} className="flex-none text-subtle" />
      <span className="flex-1 truncate font-mono text-12" title={session.repoPath}>
        {session.repoPath}
      </span>
    </div>
  ) : null;
  return (
    <FactsGroup title={t("sessions.rail.runner")}>
      <div className="flex flex-col gap-2">
        {device ? (
          <>
            <div className="flex items-center gap-2 overflow-hidden">
              <Icon name="server" size={14} className="flex-none text-subtle" />
              <span className="flex-1 truncate fg-body-sm" title={device.name}>
                {device.name}
              </span>
              <HealthDot health={deviceHealth(device.status)} />
            </div>
            <span className="fg-caption">
              {enumLabel("platform", device.platform, language)}
              {` · ${versionLabel(device.agentVersion)}`}
            </span>
          </>
        ) : (
          <div className="flex items-center gap-2 overflow-hidden">
            <Icon name="server" size={14} className="flex-none text-subtle" />
            <MonoTag hue="neutral">{deviceId.slice(0, 8)}</MonoTag>
          </div>
        )}
        {repo}
      </div>
    </FactsGroup>
  );
}
