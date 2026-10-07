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
  bindingKeys: ["installationId", "owner", "repo"],
  target: (config) => {
    const owner = text(config, "owner");
    const repo = text(config, "repo");
    return owner && repo ? `${owner}/${repo}` : null;
  },
  section: () => import("./section").then((m) => ({ default: m.GitHubSection })),
  connectionSection: null,
  connectionNote: "integrations.note.github",
};
