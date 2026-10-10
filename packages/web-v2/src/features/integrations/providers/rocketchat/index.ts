import type { ProviderModule } from "../registry";
import { urlHost } from "../config-read";

export const rocketchat: ProviderModule = {
  provider: "rocketchat",
  icon: "inbox",
  secretField: "authToken",
  secretPlaceholder: "bot personal-access token",
  drillable: true,
  agentPathKind: "none",
  bindingKeys: ["rids"],
  target: (config) => urlHost(config.serverUrl),
  section: () => import("./section").then((m) => ({ default: m.RocketchatSettings })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.RocketchatConnectionConfig })),
};
