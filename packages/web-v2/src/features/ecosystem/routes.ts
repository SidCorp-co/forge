// The ecosystem pages' URLs, built in one place so the Activity sidebar and every link agree.
// Core links a gate question to `document(slug, number)` from /api/me/attention, so that path is
// part of the API too: change it here and in core `me/attention-routes.ts:gateItem` together.

export const REGISTER_FILTERS = ["all", "awaiting", "overdue", "held", "answered", "closed"] as const;
export type RegisterFilter = (typeof REGISTER_FILTERS)[number];

const base = (projectSlug: string) => `/projects/${encodeURIComponent(projectSlug)}/ecosystem`;

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const ecosystemRoutes = {
  /** The channel register, optionally filtered and scoped to one of the project's ecosystems. */
  register: (projectSlug: string, opts: { filter?: RegisterFilter; ecosystem?: string } = {}) =>
    `${base(projectSlug)}/channel${query({
      status: opts.filter && opts.filter !== "all" ? opts.filter : undefined,
      ecosystem: opts.ecosystem,
    })}`,
  /** One document, by its number once published or by its id while a draft. */
  document: (projectSlug: string, ref: string) =>
    `${base(projectSlug)}/channel/${encodeURIComponent(ref)}`,
  /** Write a new document, a reply to `inReplyTo`, or edit the draft `draft`. */
  compose: (
    projectSlug: string,
    opts: { ecosystem?: string; inReplyTo?: string; draft?: string } = {},
  ) => `${base(projectSlug)}/channel/new${query(opts)}`,
  /** The contracts this project publishes and consumes. */
  contracts: (projectSlug: string) => `${base(projectSlug)}/contracts`,
  /** One contract's versions and measurements: the project's own, or a provider's it consumes. */
  contract: (projectSlug: string, contract: string, provider?: string) =>
    `${base(projectSlug)}/contracts/${encodeURIComponent(contract)}${query({ provider })}`,
  /** The project's API page: what it publishes, consumes and commits to. */
  apiPage: (projectSlug: string) => `${base(projectSlug)}/api`,
} as const;
