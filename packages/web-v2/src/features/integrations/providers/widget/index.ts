import type { ProviderModule } from "../registry";
import { text } from "../config-read";

// The feedback widget a client site embeds: no external credential to paste, so no secret field.
// Every field is binding-tier, one widget per project label, opened from its row on the project's
// Integrations; its signing secret, for signed visitors, is minted by core and shown once
// (rotate-secret).
export const widget: ProviderModule = {
  provider: "widget",
  icon: "chat",
  secretField: null,
  secretPlaceholder: null,
  drillable: true,
  agentPathKind: "none",
  bindingKeys: ["siteKey", "allowedOrigins", "identity", "title", "greeting", "accent", "limits"],
  target: (config) => text(config, "siteKey"),
  section: () => import("./section").then((m) => ({ default: m.WidgetSettings })),
  connectionSection: null,
  createStep: null,
  rowDetail: null,
};
