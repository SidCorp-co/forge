import type { ProviderModule } from "../registry";
import { urlHost } from "../config-read";

export const rocketchat: ProviderModule = {
  provider: "rocketchat",
  label: "Rocket.Chat",
  icon: "inbox",
  secretField: "authToken",
  secretPlaceholder: "bot personal-access token",
  drillable: true,
  agentPathKind: "core-mediated",
  mcpServerName: null,
  multiBinding: false,
  target: (config) => urlHost(config.serverUrl),
  section: () => import("./section").then((m) => ({ default: m.RocketchatSection })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.RocketchatConnectionConfig })),
  connectionNote: null,
};
