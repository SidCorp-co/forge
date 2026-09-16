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
  // cm:why `host` is a bare hostname and not a URL, so it cannot go through `urlHost` — the generic
  // reader this replaced tried `baseUrl`/`endpoint`/`serverUrl`/`url` and none of them exist on a
  // Sentry config, so every Sentry card showed no target line at all.
  target: (config) => text(config, "host"),
  section: () => import("./section").then((m) => ({ default: m.SentrySection })),
  connectionSection: null,
  connectionNote:
    "Sentry's host and the org/project targets an agent may name are edited per project, under project settings → Integrations.",
};
