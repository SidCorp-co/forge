import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const sentry: ProviderModule = {
  provider: "sentry",
  label: "Sentry",
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
    "Sentry's host and the org/project targets an agent may name belong to this connection, so every project bound to it shares them. They are edited from the Sentry drawer of a project it is bound to, under project settings → Integrations.",
};
