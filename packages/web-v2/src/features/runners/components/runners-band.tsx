// The Runners overview (REQ-43 r3 BC-14): how many devices the shown scope holds, and the flow of
// them by health, each with its count, in the tone its row's mark wears; a device turned off reads Off,
// as its row does. Counted over the very rows the table lists (L-57). A device's health is its state
// now and core serves no history of it, so the band draws no chart (BC-16 is for a state that moves).

import type { LegendTone } from "@/design";
import { OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { type DeviceRow, deviceHealth, type OrgDeviceRow } from "../types";

type Reading = "healthy" | "idle" | "down" | "off";

const READINGS: readonly { key: Reading; label: ProductCopyKey; tone: LegendTone }[] = [
  { key: "healthy", label: "common.health.healthy", tone: "ready" },
  { key: "idle", label: "common.health.idle", tone: "neutral" },
  { key: "off", label: "runners.device.off", tone: "neutral" },
  { key: "down", label: "common.health.down", tone: "blocked" },
];

/** What a device's row reads: Off where it is turned off, else its health. */
const deviceReading = (d: DeviceRow | OrgDeviceRow): Reading => (d.disabledAt ? "off" : (deviceHealth(d.status) as Reading));

export function RunnersBand({ rows }: { rows: readonly (DeviceRow | OrgDeviceRow)[] }) {
  const t = useCopy();
  const read = rows.map(deviceReading);
  return (
    <OverviewBand
      label={t("runners.band.label")}
      testId="runners-band"
      figures={[{ key: "devices", value: rows.length, label: t("runners.screen.devices") }]}
      flow={READINGS.map((r) => ({ key: r.key, label: t(r.label), count: read.filter((x) => x === r.key).length, tone: r.tone }))}
    />
  );
}
