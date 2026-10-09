// @direct-test-of packages/core/src/guides/
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import { provideAssistantMethod } from './assistant-method-guide.js';
import { getGuide, listGuides } from './registry.js';
import { guideRoutes } from './routes.js';

// The OpenAPI contract is generated from `app.routes`, what Hono dispatches on, and
// `check-api-contracts` holds it byte-equal to the mounted app, so a path it lacks is one no request
// reaches.
const contract = JSON.parse(
  readFileSync(new URL('../../contracts/forge-api.openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };

type Paths = Record<string, Record<string, unknown>>;
interface Cited {
  method: string;
  path: string;
}

const CITED = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s`'"(),;|]+)/g;
const isParam = (segment: string) => /^[:<{]/.test(segment);

/** Each `METHOD /api/...` a body cites, its query and a served page's `.md` taken off. */
function citedRoutes(body: string): Cited[] {
  return [...body.matchAll(CITED)].map(([, method, raw]) => ({
    method: method ?? '',
    path: (raw ?? '')
      .split('?')[0]
      ?.replace(/[.:]+$/, '')
      .replace(/\.md$/, '') as string,
  }));
}

/** A cited path matches a contract path segment by segment; a parameter only another parameter. */
function mounted({ method, path }: Cited, paths: Paths): boolean {
  const cited = path.split('/');
  return Object.entries(paths).some(([served, methods]) => {
    const parts = served.split('/');
    return (
      parts.length === cited.length &&
      method.toLowerCase() in methods &&
      parts.every((part, i) =>
        isParam(part) ? true : !isParam(cited[i] ?? '') && part === cited[i],
      )
    );
  });
}

function unmountedRoutes(body: string, paths: Paths): string[] {
  return citedRoutes(body)
    .filter((c) => !mounted(c, paths))
    .map((c) => `${c.method} ${c.path}`);
}

/** A command of the plugin's `forge` CLI written as code; `forge-runner` is the box's own. */
function pluginCommands(body: string): string[] {
  return [...body.matchAll(/`(forge [a-z][^`]*)`/g)].map(([, command]) => command ?? '');
}

// What the composition root hands in at boot, so that guide's routes are read as served.
provideAssistantMethod(composeLayers(METHOD_LAYERS));

const bodies = listGuides().map(({ slug }) => ({ slug, body: getGuide(slug)?.body ?? '' }));

describe('the routes a guide cites', () => {
  it('reads a cited route out of a body, whatever stands in for its parameters', () => {
    expect(
      citedRoutes(
        'Move it with `POST /api/issues/:id/transition`, read `GET /api/issues/<key>?projectId=<uuid>` and `GET /api/guides/issue-flow.md`.',
      ),
    ).toEqual([
      { method: 'POST', path: '/api/issues/:id/transition' },
      { method: 'GET', path: '/api/issues/<key>' },
      { method: 'GET', path: '/api/guides/issue-flow' },
    ]);
  });

  it('refuses a route core does not mount, naming it, and passes one it does', () => {
    const planted =
      'Claim it with `POST /api/issues/:id/claim`, then `POST /api/issues/:id/merge`.';
    expect(unmountedRoutes(planted, contract.paths)).toEqual(['POST /api/issues/:id/claim']);
  });

  it('refuses a mounted path cited with a method it does not answer', () => {
    expect(unmountedRoutes('`DELETE /api/issues/:id/transition`', contract.paths)).toEqual([
      'DELETE /api/issues/:id/transition',
    ]);
  });

  it.each(bodies)('$slug cites only routes core mounts', ({ body }) => {
    expect(unmountedRoutes(body, contract.paths)).toEqual([]);
  });
});

describe('the method guides a pane follows', () => {
  // A dev pane's own core serves these two; the plugin CLI is built against another core's statuses
  // and records, so a step sending the reader to it is one its core may refuse (ISS-275).
  const METHODS = ['issue-flow', 'dispatch'] as const;

  it('finds a plugin command written in a body', () => {
    expect(
      pluginCommands('Take it with `forge claim ISS-1`; `forge-runner api issues` reads it.'),
    ).toEqual(['forge claim ISS-1']);
  });

  it.each(METHODS)('%s is served and names no plugin command', async (slug) => {
    const res = await guideRoutes.request(`/guides/${slug}.md`);
    expect(res.status, `guide ${slug} is not served`).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(pluginCommands(await res.text())).toEqual([]);
  });

  it.each(METHODS)('%s is listed in the index an agent reads first', async (slug) => {
    const res = await guideRoutes.request('/guides');
    const { guides } = (await res.json()) as { guides: { slug: string }[] };
    expect(guides.map((g) => g.slug)).toContain(slug);
  });
});

// R-30: a public guide cited Forge's own issue keys (ISS-54, ISS-1108, forge-plugin ISS-347), which
// no reader of another project can open and which go stale as the issues close.
describe('the prose a guide serves', () => {
  /** Every issue key a body cites, bar one written as the example of a display key. */
  const issueKeys = (body: string) =>
    [...body.matchAll(/\bISS-\d+\b/g)]
      .filter((m) => !/such as \\?`$/.test(body.slice(Math.max(0, (m.index ?? 0) - 10), m.index)))
      .map((m) => m[0]);

  it('finds a key cited in prose and passes one given as a key example', () => {
    expect(issueKeys('folded into needs_info (ISS-54).')).toEqual(['ISS-54']);
    expect(issueKeys('resolves a display key such as `ISS-42` and answers')).toEqual([]);
  });

  it.each(bodies)('$slug cites no issue key', ({ body }) => {
    expect(issueKeys(body)).toEqual([]);
  });
});
