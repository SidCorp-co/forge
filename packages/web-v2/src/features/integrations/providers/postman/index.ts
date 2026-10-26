import { PROVIDER_LABELS } from "@forge/contracts/health-words";
import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const postman: ProviderModule = {
  provider: "postman",
  label: PROVIDER_LABELS.postman,
  icon: "command",
  secretField: "apiKey",
  secretPlaceholder: "PMAK-…",
  previousKeyNote: null,
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
