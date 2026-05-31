"use client";

// One device card: header (name · platform · health) + its per-project runner
// rows + a footer summarising online runners. Offline devices/runners surface a
// ReconnectingBanner. Composes entirely from @/design.
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  HealthDot,
  IconButton,
  Menu,
  MonoTag,
  ReconnectingBanner,
  type MenuItem,
} from "@/design";
import { useElapsed } from "@/design";
import { RunnerRow } from "./runner-row";
import { useRevokeDevice } from "../hooks";
import { deviceHealth, isDeviceOffline, type MyDevice, type RunnerDetail } from "../types";

function lastSeenLabel(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "never";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DeviceCard({
  device,
  runners,
  projectNames,
}: {
  device: MyDevice;
  runners: RunnerDetail[];
  projectNames: Record<string, string>;
}) {
  const revoke = useRevokeDevice();
  const offline = isDeviceOffline(device, runners);
  const online = runners.filter((r) => r.status === "online").length;
  // Keep the relative "last seen" label live for online devices.
  useElapsed(device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : undefined, device.status === "online");

  const items: MenuItem[] = [
    { label: "Revoke device", icon: "trash", danger: true, onSelect: () => revoke.mutate(device.id) },
  ];

  return (
    <Card>
      <CardContent>
        <div className="flex items-start gap-2.5">
          <HealthDot health={deviceHealth(device.status)} withLabel={false} />
          <div className="min-w-0 flex-1">
            <p className="fg-body-sm truncate font-semibold text-fg">{device.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <MonoTag>{device.platform}</MonoTag>
              {device.agentVersion && <span className="fg-caption">v{device.agentVersion}</span>}
              <span className="fg-caption">· seen {lastSeenLabel(device.lastSeenAt)}</span>
            </div>
          </div>
          <Menu
            align="right"
            items={items}
            trigger={<IconButton icon="more" aria-label="Device actions" className="min-h-11 min-w-11" />}
          />
        </div>

        {offline && (
          <div className="mt-3">
            <ReconnectingBanner
              label={
                device.status === "offline"
                  ? "Device offline — reconnecting…"
                  : "A runner is offline — reconnecting…"
              }
            />
          </div>
        )}

        <div className="mt-3 space-y-2">
          {runners.length === 0 ? (
            <p className="fg-caption rounded-md border border-dashed border-line bg-sunken px-3 py-3 text-center">
              No runners assigned to this device.
            </p>
          ) : (
            runners.map((r) => (
              <RunnerRow key={r.id} runner={r} projectName={projectNames[r.projectId] ?? "Unknown project"} />
            ))
          )}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-line-subtle pt-3">
          <span className="fg-caption">
            {runners.length} runner{runners.length === 1 ? "" : "s"}
          </span>
          <Badge tone={online > 0 ? "accent" : "neutral"}>{online} online</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

/** Empty placeholder when the caller has no paired devices at all. */
export function NoDevices({ onPair }: { onPair: () => void }) {
  return (
    <EmptyState
      title="No devices paired"
      message="Pair a device to run agents on your own hardware. Devices appear here with their per-project runners, status, and Claude quota."
      action={{ label: "Pair a device", onClick: onPair }}
    />
  );
}
