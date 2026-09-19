import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const github: ProviderModule = {
  provider: "github",
  label: "GitHub",
  icon: "github",
  secretField: null,
  secretPlaceholder: null,
  drillable: true,
  agentPathKind: "core-mediated",
  mcpServerName: null,
  multiBinding: false,
  target: (config) => {
    const owner = text(config, "owner");
    const repo = text(config, "repo");
    return owner && repo ? `${owner}/${repo}` : null;
  },
  section: () => import("./section").then((m) => ({ default: m.GitHubSection })),
  connectionSection: null,
  connectionNote:
    "The App installation holds this credential. Replace it by re-running the App install from a project's settings → Integrations; the repository each project points at is set there too.",
};
