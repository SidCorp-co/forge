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
  bindingKeys: [],
  target: (config) => text(config, "host"),
  section: () => import("./section").then((m) => ({ default: m.SentrySection })),
  connectionSection: null,
  connectionNote: "integrations.note.sentry",
};
