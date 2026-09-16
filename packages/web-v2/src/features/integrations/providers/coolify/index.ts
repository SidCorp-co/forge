import type { ProviderModule } from "../registry";
import { urlHost } from "../config-read";

export const coolify: ProviderModule = {
  provider: "coolify",
  label: "Coolify deploy",
  icon: "server",
  secretField: "apiToken",
  secretPlaceholder: "Coolify API token",
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
