// contract -> packages/core/src/me/attention-routes.ts:gateItem — core links a gate question to `document(slug, number)`, so that path is part of the API and changes in both places together

/** The Threads inbox's views, one per counter at the top of the page. */
export const INBOX_VIEWS = ["needs-me", "waiting", "overdue", "held", "working", "answered", "closed"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

const base = (projectSlug: string) => `/projects/${encodeURIComponent(projectSlug)}/ecosystem`;

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
};

// an ecosystem spans projects from any organization, so its page, the Threads inbox and the create form live at the workspace; a document, its compose form and the API page are a project's own and stay under it
export const ecosystemRoutes = {
  list: () => "/ecosystems",
  create: () => "/ecosystems/new",
  ecosystem: (id: string) => `/ecosystems/${encodeURIComponent(id)}`,
  settings: (id: string) => `/ecosystems/${encodeURIComponent(id)}/settings`,
  threads: (opts: { view?: InboxView; ecosystem?: string; project?: string; type?: string } = {}) =>
    `/ecosystems/threads${query({
      view: opts.view && opts.view !== "needs-me" ? opts.view : undefined,
      ecosystem: opts.ecosystem,
      project: opts.project,
      type: opts.type,
    })}`,
  document: (projectSlug: string, ref: string) =>
    `${base(projectSlug)}/channel/${encodeURIComponent(ref)}`,
  compose: (
    projectSlug: string,
    opts: { ecosystem?: string; inReplyTo?: string; draft?: string } = {},
  ) => `${base(projectSlug)}/channel/new${query(opts)}`,
  apiPage: (projectSlug: string) => `${base(projectSlug)}/api`,
} as const;
