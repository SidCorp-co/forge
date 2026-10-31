// @direct-test-of packages/core/src/guides/
// What a reader holding only REST learns from the guides core serves with no credential: how to
// judge an issue (ISS-612), and the whole shape of a design write and its trace (ISS-579). Each
// guide is read as the public route serves it, so a guide left out of the registry goes red here.

import { WORKFLOW_LIMITS, WORKFLOW_V2_SCHEMA_ID } from '@forge/contracts/workflows';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { guideRoutes } from './routes.js';

async function served(slug: string): Promise<string> {
  const res = await guideRoutes.request(`/guides/${slug}.md`);
  expect(res.status, `guide ${slug} is not served`).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/markdown');
  return (await res.text()).replace(/\s+/g, ' ');
}

const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, `no section ${from}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

describe('the judging guide a REST-only judge reads (ISS-612)', () => {
  it('is listed in the public index under its slug', async () => {
    const res = await guideRoutes.request('/guides');
    const { guides } = (await res.json()) as { guides: { slug: string; title: string }[] };
    expect(guides.find((g) => g.slug === 'qa')?.title).toMatch(/judg/i);
  });

  it('names the REST reads for what is owed, where to start, and the verdict history', async () => {
    const qa = await served('qa');
    for (const read of [
      '`GET /api/projects/:id/policy`',
      '`GET /api/projects/:id/issues?status=awaiting_release`',
      '`GET /api/issues/:id/criteria`',
      '`GET /api/issues/:id/design`',
      '`GET /api/issues/:id/review`',
      '`GET /api/issues/:id/judged-build`',
      '`GET /api/projects/:id/config`',
      '`latest`',
      '`GET /api/issues/:id/events?kind=verdict`',
      '`retired`',
      '`POST /api/issues/:id/verdicts`',
    ]) {
      expect(qa, `the qa guide no longer names ${read}`).toContain(read);
    }
  });

  it('judges a design issue on its newest approved revision, never on content only proposed', async () => {
    const qa = await served('qa');
    const design = between(qa, '### A design issue', '###');
    expect(design).toContain("`identity: { kind: 'design', workflow, revision }`");
    expect(design).toContain('the newest approved revision');
    expect(design).toContain('`approvedRevision`');
    expect(design).toContain('does not satisfy the criterion');
    expect(design).toContain('VERDICT_DESIGN_UNAPPROVED');
    expect(design).toContain('`GET /api/projects/:id/workflows/:workflow/design`');
  });
});

describe('the design-write shape the workflow-design guide gives (ISS-579)', () => {
  it('traces a criterion onto steps with the route, the workflow it names and the nodes it takes', async () => {
    for (const slug of ['workflow-design', 'requirement-lifecycle']) {
      const text = await served(slug);
      expect(text).toContain('PUT /api/projects/:id/requirements/:req/criteria/:code/steps');
      expect(text, slug).toContain("the design's flow name or its uuid");
      expect(text, slug).toContain('the step ids of its newest revision');
      expect(text, slug).toContain('REQUIREMENT_DESIGN_UNLINKED');
      expect(text, slug).toContain('WORKFLOW_NODE_UNKNOWN');
    }
  });

  it('gives the whole create body and the fields its document carries', async () => {
    const design = await served('workflow-design');
    expect(design).toContain(
      '`POST /api/projects/:id/workflows` `{ baseRevision: null, document }`',
    );
    for (const field of [
      `\`$schema: "${WORKFLOW_V2_SCHEMA_ID}"\``,
      '`version: 2`',
      '`project`',
      '`flow`',
      '`kind`',
      '`title`',
      '`summary`',
      '`steps`',
      '`template`',
      '`writtenBy`',
    ]) {
      expect(design, `the create body no longer names ${field}`).toContain(field);
    }
  });

  it('says every write carries writtenBy, what it holds, and that an empty object is accepted', async () => {
    const design = await served('workflow-design');
    expect(design).toContain('`writtenBy: { runId?, sessionId?, sha? }`');
    expect(design).toContain('every write carries it');
    expect(design).toContain('`{}` is accepted');
  });

  it('lists every size cap a design is refused over, at the value core enforces', async () => {
    const caps = between(await served('workflow-design'), '### What a design may hold', '###');
    for (const [key, max] of Object.entries(WORKFLOW_LIMITS)) {
      expect(caps, `the caps no longer list ${key} at ${max}`).toContain(`(\`${key}\`) | ${max} |`);
    }
  });

  it('gives the whole park body that waits on a design decision, need text optional', async () => {
    const design = await served('workflow-design');
    expect(design).toContain(
      "`POST /api/issues/:id/transition` `{ toStatus: 'needs_info', waitingKind: 'needs_decision', reason, awaitsDesign: { workflowId, revision } }`",
    );
    expect(design).toContain('`needs` may be left out');
  });
});

describe('where a dispatcher puts the standing rules (ISS-816)', () => {
  it('sends them beside a plugin-gated brief, never below a prompt sent unchanged', async () => {
    const step = between(
      await served('dispatch'),
      '2. `forge-runner run brief <run id>`',
      '3. A `wave`',
    );
    expect(step).toContain(
      "With no other brief gate in the pane, the project's standing rules are added below it.",
    );
    expect(step).toContain('never go in or below that prompt');
    expect(step).toContain(
      'one comment on each issue the run takes (`POST /api/issues/:id/comments`)',
    );
    expect(step).toContain('the one-line `next` of the lease you hand over');
    const brief = between(await served('dispatch'), '- **The brief**', '### 6.');
    expect(brief).not.toContain("and the project's standing rules a run cannot read");
  });
});

describe('the index an agent reads first (llms.txt)', () => {
  it('links the API contract and the MCP tool list at /api, from either mount', async () => {
    const atApi = new Hono().route('/api', guideRoutes);
    for (const [routes, path] of [
      [guideRoutes, '/llms.txt'],
      [atApi, '/api/llms.txt'],
    ] as const) {
      const text = await (await routes.request(`http://forge.test${path}`)).text();
      expect(text, path).toContain('(http://forge.test/api/openapi.json)');
      expect(text, path).toContain('(http://forge.test/api/mcp-tools.json)');
    }
  });
});
