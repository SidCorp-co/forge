import Link from "next/link";
import { EmptyState } from "@/design";
import type { OperatorSectionKey } from "../types";

type PlaceholderSection = Exclude<OperatorSectionKey, "overview">;

const SECTION_COPY: Record<PlaceholderSection, { title: string; message: string }> = {
  alerts: {
    title: "Alerts are on the Overview",
    message: "Every alert is listed in the Overview's Alerts section, critical first.",
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
  // The section's whole page: its state heads it and names the tab (ISS-1229 r47, judge-137). Alerts are
  // read on the Overview already, so this page sends the reader there (ISS-1229 r48).
  const message =
    section === "alerts" ? (
      <>
        {copy.message}{" "}
        <Link href="/admin" className="text-accent-text hover:underline">
          Open the Overview&apos;s Alerts
        </Link>
      </>
    ) : (
      copy.message
    );
  return <EmptyState level={1} title={copy.title} message={message} />;
}
