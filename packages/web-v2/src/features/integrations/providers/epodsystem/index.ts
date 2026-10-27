import { PROVIDER_LABELS } from "@forge/contracts/health-words";
import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const epodsystem: ProviderModule = {
  provider: "epodsystem",
  label: PROVIDER_LABELS.epodsystem,
  icon: "command",
  secretField: "apiKey",
  secretPlaceholder: "crmk_…",
  previousKeyNote: null,
  drillable: true,
  agentPathKind: "direct-mcp",
  mcpServerName: "epodsystem",
  multiBinding: true,
  addAnother: "Add storefront",
  target: (config) => text(config, "storeSlug") ?? text(config, "storeName"),
  section: () => import("./section").then((m) => ({ default: m.EpodsystemSection })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.EpodsystemConnectionConfig })),
  connectionNote: null,
};
