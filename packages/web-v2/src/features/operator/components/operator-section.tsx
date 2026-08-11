import { EmptyState } from "@/design";
import type { OperatorSectionKey } from "../types";

const SECTION_COPY: Record<OperatorSectionKey, { title: string; message: string }> = {
  overview: {
    title: "No overview data yet",
    message: "Deployment-wide signals land here in a later step.",
  },
  alerts: {
    title: "No alerts yet",
    message: "Alert rules haven't been wired up yet.",
  },
  fleet: {
    title: "No fleet data yet",
    message: "Runner telemetry lands with the next step.",
  },
  pipeline: {
    title: "No pipeline data yet",
    message: "Pipeline-wide run metrics land with the next step.",
  },
  growth: {
    title: "No growth data yet",
    message: "Adoption metrics land with the next step.",
  },
  "mcp-logs": {
    title: "No MCP logs yet",
    message: "MCP tool-call logs land with the next step.",
  },
};

export function OperatorSection({ section }: { section: OperatorSectionKey }) {
  const copy = SECTION_COPY[section];
  return <EmptyState title={copy.title} message={copy.message} />;
}
