import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const autoflow: ProviderModule = {
  provider: "autoflow",
  label: "Autoflow",
  icon: "flow",
  secretField: "accessToken",
  secretPlaceholder: "sat_…",
  drillable: true,
  agentPathKind: "direct-mcp",
  bindingKeys: ["shop"],
  target: (config) => text(config, "shop") ?? text(config, "storeSlug") ?? text(config, "storeName"),
  section: () => import("./section").then((m) => ({ default: m.AutoflowSection })),
  connectionSection: null,
  connectionNote: "integrations.note.autoflow",
};
