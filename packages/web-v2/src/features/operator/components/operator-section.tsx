import { EmptyState } from "@/design";
import type { OperatorSectionKey } from "../types";

// cm:guard a section stays in this map only until its own screen lands, and leaves it in the same change — `overview` left in ISS-653, because a placeholder shipping beside the thing it stood in for is a second live path no reader can tell apart
type PlaceholderSection = Exclude<OperatorSectionKey, "overview">;

const SECTION_COPY: Record<PlaceholderSection, { title: string; message: string }> = {
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

export function OperatorSection({ section }: { section: PlaceholderSection }) {
  const copy = SECTION_COPY[section];
  return <EmptyState title={copy.title} message={copy.message} />;
}
