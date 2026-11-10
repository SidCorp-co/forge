// The Attention page's overview (REQ-43 r3 BC-14): how many rows wait on the person, and the flow of
// what kind each is, each with its count, toned by what it means (a decision or a gate is the
// reader's, a failure red, an offline box slate). Counted from core's own counts, the very counts each
// section under it heads (L-57): they sum to core's `total`. An inbox holds no state that moves over
// time, so the band draws no chart (BC-16 is for a screen whose state moves).

import type { CoverageSegment, LegendTone } from "@/design";
import { OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { AttentionView } from "../types";

type Part = keyof AttentionView["counts"];

const PARTS: readonly { key: Part; label: ProductCopyKey; tone: LegendTone }[] = [
  { key: "decisions", label: "attention.band.decisions", tone: "you" },
  { key: "owed", label: "attention.band.owed", tone: "you" },
  { key: "channelGates", label: "attention.group.channelGates", tone: "you" },
  { key: "mentions", label: "attention.group.mentions", tone: "neutral" },
  { key: "failedJobs", label: "attention.group.failedJobs", tone: "err" },
  { key: "statusReports", label: "attention.group.statusReports", tone: "neutral" },
  { key: "offlineRunners", label: "attention.group.offlineRunners", tone: "blocked" },
];

export function AttentionBand({ view }: { view: AttentionView }) {
  const t = useCopy();
  const flow: CoverageSegment[] = PARTS.map((p) => ({ key: p.key, label: t(p.label), count: view.counts[p.key], tone: p.tone }));
  return <OverviewBand label={t("attention.band.label")} testId="attention-band" figures={[{ key: "total", value: view.total, label: t("attention.band.total") }]} flow={flow} />;
}
