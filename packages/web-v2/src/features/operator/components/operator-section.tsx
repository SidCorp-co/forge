"use client";

import { EmptyState } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { OperatorSectionKey } from "../types";

type PlaceholderSection = Exclude<OperatorSectionKey, "overview">;

// a section with nothing built behind it yet reads as empty, in two words
const EMPTY: Record<PlaceholderSection, ProductCopyKey> = {
  alerts: "operator.placeholder.alertsEmpty",
  fleet: "operator.placeholder.fleetEmpty",
  pipeline: "operator.placeholder.pipelineEmpty",
  growth: "operator.placeholder.growthEmpty",
  "mcp-logs": "operator.placeholder.mcpLogsEmpty",
};

export function OperatorGroup({ section }: { section: PlaceholderSection }) {
  const t = useCopy();
  return <EmptyState message={t(EMPTY[section])} />;
}
