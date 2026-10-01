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
  bindingKeys: ["targets"],
  bindingTarget: {
    toTarget: (config) => ({
      applications: (Array.isArray(config.targets) ? config.targets : []).map((t) => {
        const { id, label, resourceUuid, healthUrl } = t as Record<string, unknown>;
        return {
          ...(typeof id === "string" && id !== label ? { id } : {}),
          label,
          resourceUuid,
          ...(healthUrl === undefined ? {} : { healthUrl }),
        };
      }),
    }),
    toConfig: (target) => ({
      targets: (Array.isArray(target.applications) ? target.applications : []).map((a) => {
        const app = a as Record<string, unknown>;
        return { id: app.id ?? app.label, ...app };
      }),
    }),
  },
  target: (config) => urlHost(config.baseUrl),
  section: () => import("./section").then((m) => ({ default: m.CoolifySection })),
  connectionSection: () =>
    import("./connection-config").then((m) => ({ default: m.CoolifyConnectionConfig })),
  connectionNote: null,
};
