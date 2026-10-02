import type { ProviderModule } from "../registry";
import { text } from "../config-read";

export const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com";

/** The host a base URL serves; an absent or unparseable one reads as gitlab.com. */
export function gitlabHost(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl?.trim() || GITLAB_DEFAULT_BASE_URL).host.toLowerCase();
  } catch {
    return "gitlab.com";
  }
}

export const gitlab: ProviderModule = {
  provider: "gitlab",
  label: "GitLab",
  icon: "branch",
  secretField: "token",
  secretPlaceholder: "glpat-…",
  drillable: true,
  agentPathKind: "core-mediated",
  bindingKeys: ["projectPath", "projectId"],
  target: (config) => {
    const path = text(config, "projectPath");
    return path ? `${gitlabHost(text(config, "baseUrl") ?? undefined)}/${path}` : null;
  },
  section: () => import("./section").then((m) => ({ default: m.GitlabSection })),
  connectionSection: null,
  connectionNote: null,
};
