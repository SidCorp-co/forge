import type { ProviderModule } from "../registry";
import { urlHost } from "../config-read";

export const coolify: ProviderModule = {
  provider: "coolify",
  label: "Coolify",
  icon: "server",
  secretField: "apiToken",
  secretPlaceholder: "Coolify API token",
  previousKeyNote:
    "Forge keeps the previous key for 24 hours and uses it for its own calls wherever Coolify refuses the new one.",
  drillable: true,
  agentPathKind: "core-mediated",
  mcpServerName: null,
  multiBinding: false,
  target: (config) => urlHost(config.baseUrl),
  section: () => import("./section").then((m) => ({ default: m.CoolifySection })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.CoolifyConnectionConfig })),
  connectionNote: null,
};
