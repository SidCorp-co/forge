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
    "A Sentry connection holds the host and token its projects share; each project picks the Sentry projects its agents may name under project settings → Integrations, so none can name another's.",
};
