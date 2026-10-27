import { PROVIDER_LABELS } from "@forge/contracts/health-words";
import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const sentry: ProviderModule = {
  provider: "sentry",
  label: PROVIDER_LABELS.sentry,
  icon: "shield",
  secretField: "authToken",
  secretPlaceholder: "sntryu_…",
  previousKeyNote:
    "Forge keeps the previous key for 24 hours and uses it for its own calls wherever Sentry refuses the new one.",
  drillable: true,
  agentPathKind: "direct-mcp",
  mcpServerName: "sentry",
  multiBinding: false,
  target: (config) => text(config, "host"),
  section: () => import("./section").then((m) => ({ default: m.SentrySection })),
  connectionSection: null,
  connectionNote:
    "Sentry's host and the org/project targets an agent may name belong to this connection, so every project it is shared with shares them. They are edited from the Sentry drawer of a project it is shared with, under project settings → Integrations.",
};
