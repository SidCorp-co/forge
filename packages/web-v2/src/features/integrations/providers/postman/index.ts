import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const postman: ProviderModule = {
  provider: "postman",
  label: "Postman",
  icon: "command",
  secretField: "apiKey",
  secretPlaceholder: "PMAK-…",
  drillable: true,
  agentPathKind: "direct-mcp",
  mcpServerName: "postman",
  multiBinding: false,
  target: (config) => text(config, "workspaceName"),
  section: () => import("./section").then((m) => ({ default: m.PostmanSection })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.PostmanConnectionConfig })),
  connectionNote: null,
};
