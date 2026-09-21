import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const sentry: ProviderModule = {
  provider: "sentry",
  label: "Sentry",
  icon: "shield",
  secretField: "authToken",
  secretPlaceholder: "sntryu_…",
  drillable: true,
  agentPathKind: "direct-mcp",
  mcpServerName: "sentry",
  multiBinding: false,
  target: (config) => text(config, "host"),
  section: () => import("./section").then((m) => ({ default: m.SentrySection })),
  connectionSection: null,
  connectionNote:
    "Sentry's host and the org/project targets an agent may name are edited per project, under project settings → Integrations.",
};
