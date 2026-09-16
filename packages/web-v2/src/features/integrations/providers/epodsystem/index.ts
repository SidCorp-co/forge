import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const epodsystem: ProviderModule = {
  provider: "epodsystem",
  label: "Epodsystem",
  icon: "command",
  secretField: "apiKey",
  secretPlaceholder: "crmk_…",
  drillable: true,
  agentPathKind: "direct-mcp",
  mcpServerName: "epodsystem",
  multiBinding: true,
  target: (config) => text(config, "storeSlug") ?? text(config, "storeName"),
  section: () => import("./section").then((m) => ({ default: m.EpodsystemSection })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.EpodsystemConnectionConfig })),
  connectionNote: null,
};
