import { REGISTER_STATUSES } from "@forge/contracts/status-sets";

// cm:edge contract -> packages/core/src/me/attention-routes.ts:gateItem — core links a gate question to `document(slug, number)`, so that path is part of the API and changes in both places together

/** The page's filters: every status core's register filters by, sent as is, and "all". */
export const REGISTER_FILTERS = ["all", ...REGISTER_STATUSES] as const;
export type RegisterFilter = (typeof REGISTER_FILTERS)[number];

const base = (projectSlug: string) => `/projects/${encodeURIComponent(projectSlug)}/ecosystem`;

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const ecosystemRoutes = {
  register: (projectSlug: string, opts: { filter?: RegisterFilter; ecosystem?: string } = {}) =>
    `${base(projectSlug)}/channel${query({
      status: opts.filter && opts.filter !== "all" ? opts.filter : undefined,
      ecosystem: opts.ecosystem,
    })}`,
  document: (projectSlug: string, ref: string) =>
    `${base(projectSlug)}/channel/${encodeURIComponent(ref)}`,
  compose: (
    projectSlug: string,
    opts: { ecosystem?: string; inReplyTo?: string; draft?: string } = {},
  ) => `${base(projectSlug)}/channel/new${query(opts)}`,
  contracts: (projectSlug: string) => `${base(projectSlug)}/contracts`,
  contract: (projectSlug: string, contract: string, provider?: string) =>
    `${base(projectSlug)}/contracts/${encodeURIComponent(contract)}${query({ provider })}`,
  apiPage: (projectSlug: string) => `${base(projectSlug)}/api`,
} as const;
