export const AGENTS_LIST = "agents";

export const agentsListHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/agents`;

export const runHref = (slug: string, runId: string) => `${agentsListHref(slug)}/runs/${encodeURIComponent(runId)}`;

/** The Sessions tab narrowed to one issue's sessions; core filters `GET /agent-sessions` by `issueId`. */
export const issueSessionsHref = (slug: string, issueId: string) =>
  `${agentsListHref(slug)}?tab=sessions&issue=${encodeURIComponent(issueId)}`;

export const masterHref = (slug: string) => `${agentsListHref(slug)}/master`;

/** The peek key of the master row; a run's key is its uuid, so the two never meet. */
export const MASTER_KEY = "master";
