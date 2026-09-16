/**
 * ISS-1066 — the routes the per-run project brief is assembled from, scripted for the tests. Split
 * out of `fake-deployment.ts`, which was at the 500-line file budget.
 */

import type { FakeCtx } from './fake-deployment.js';

/** ISS-1066 — the routes the per-run project brief is assembled from. */
export function briefRoutes(
  ctx: FakeCtx,
  method: string,
  url: URL,
  json: (status: number, body: unknown) => Response,
): Response | null {
  const path = url.pathname;
  const base = `/api/projects/${ctx.project.id}`;
  if (method !== 'GET') return null;
  if (path === base)
    return json(200, {
      ...ctx.project,
      description: ctx.opts.detail?.description ?? 'A project the benchmark walks.',
      issuePrefix: ctx.opts.detail?.issuePrefix ?? 'ISS',
    });
  if (path === `${base}/project-facts`)
    return json(200, { projectFacts: ctx.opts.projectFacts ?? {}, projectFactsConfig: {} });
  if (path === `${base}/knowledge`) {
    if (ctx.opts.knowledgeStatus)
      return json(ctx.opts.knowledgeStatus, { error: 'not a project member' });
    const injection = url.searchParams.get('injection');
    const all = (ctx.opts.knowledge ?? []).filter((e) => !injection || e.injection === injection);
    // cm:why the cap applies only to the UNFILTERED index, as the route's own does: `trimToResponseCap`
    // runs over whatever the query matched, so a narrowed read of a large project comes back whole.
    // That asymmetry is the whole of what `knowledgeIndexCap` plants (ISS-1066, codex F1).
    const cap = injection ? undefined : ctx.opts.knowledgeIndexCap;
    const kept = cap === undefined ? all : all.slice(0, cap);
    const rows = kept.map(({ body: _body, ...row }) => row);
    return json(200, {
      rows,
      returned: rows.length,
      total: all.length,
      truncated: rows.length < all.length,
    });
  }
  const entry = new RegExp(`^${base}/knowledge/([^/]+)$`).exec(path);
  if (entry) {
    const hit = (ctx.opts.knowledge ?? []).find((e) => e.slug === entry[1]);
    return hit
      ? json(200, { ...hit, body: hit.body ?? '' })
      : json(404, { error: 'no such entry' });
  }
  return null;
}
