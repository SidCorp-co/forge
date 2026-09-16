import { describe, expect, it } from 'vitest';
import {
  BRIEF_MAX_CHARS,
  BriefRefusal,
  fixtureNotApplicable,
  type ProjectBriefSource,
  projectBrief,
  readProjectBrief,
} from './brief.js';
import { createClient, DeploymentRefusal } from './client.js';
import {
  createFakeDeployment,
  FAKE_CLOSED,
  FAKE_ISSUE,
  FAKE_PROJECT,
  FAKE_TOKEN,
  type FakeOptions,
} from './fake-deployment.js';
import { loadTasks } from './tasks/index.js';

const source = (over: Partial<ProjectBriefSource> = {}): ProjectBriefSource => ({
  slug: 'qa-sandbox',
  detail: { name: 'QA Sandbox', description: 'A place to walk the assistant.', issuePrefix: 'QA' },
  counts: {
    openCount: 5,
    closedCount: 2,
    draftCount: 1,
    byStatus: { open: 5, closed: 2, draft: 1 },
  },
  pipelineStates: [
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'developed',
    'testing',
    'awaiting_release',
    'closed',
  ],
  intakeGate: false,
  facts: { 'deploy-window': 'Thursdays at 14:00 UTC, never on a Friday.' },
  knowledge: [
    {
      slug: 'overview',
      title: 'What we are building',
      kind: 'overview',
      injection: 'always',
      body: 'A control plane for agents.',
    },
    {
      slug: 'glossary',
      title: 'Words we use',
      kind: 'glossary',
      injection: 'on_demand',
      body: null,
    },
  ],
  knowledgeOmitted: 0,
  newestIssues: [{ key: 'QA-9', title: 'The newest one', status: 'open' }],
  newestOpenIssues: [{ id: 'aaaa', key: 'QA-9', title: 'The newest one' }],
  waitingIssue: { id: 'bbbb', key: 'QA-4', title: 'Waiting on the customer' },
  readAt: '2026-09-17T00:00:00.000Z',
  ...over,
});

describe('projectBrief (ISS-1066)', () => {
  it('carries every section the judge is meant to check a project claim against', () => {
    const text = projectBrief(source());
    expect(text).toContain('QA Sandbox (qa-sandbox)');
    expect(text).toContain('open 5');
    expect(text).toContain('closed 2');
    expect(text).toContain('draft 1');
    expect(text).toContain('open → confirmed → approved');
    expect(text).toContain('`QA-<number>`');
    expect(text).toContain('QA-4 — Waiting on the customer');
    expect(text).toContain('A place to walk the assistant.');
    expect(text).toContain('QA-9');
  });

  it('carries a project fact’s own body text, not a heading saying facts exist', () => {
    expect(projectBrief(source())).toContain('Thursdays at 14:00 UTC, never on a Friday.');
  });

  it('carries an always-injected knowledge entry’s own body text', () => {
    expect(projectBrief(source())).toContain('A control plane for agents.');
  });

  it('says a project holds no knowledge rather than leaving the section out', () => {
    const text = projectBrief(source({ knowledge: [] }));
    expect(text).toContain('Knowledge entries');
    expect(text).toContain('The project holds no knowledge entries.');
  });

  it('says a project has no waiting issue rather than leaving the reader to infer it', () => {
    expect(projectBrief(source({ waitingIssue: null }))).toContain(
      'The project holds no issue waiting on information.',
    );
  });

  it('names the intake gate when it is on, because it changes where a filing lands', () => {
    expect(projectBrief(source({ intakeGate: true }))).toContain('parked at `draft`');
  });

  // cm:why the description alone: dropping sections from the END would let one long author field
  // take the counts and the pipeline with it, which is the half the motivating false count is
  // checked against (codex F4 on the ISS-1066 plan)
  it('keeps the counts, the pipeline and the filing rules whole under a description that blows the cap', () => {
    const text = projectBrief(
      source({
        detail: { name: 'QA Sandbox', description: 'x'.repeat(20_000), issuePrefix: 'QA' },
      }),
    );
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(text).toContain('open 5 · closed 2 · draft 1 — 8 in all.');
    expect(text).toContain('open → confirmed → approved');
    expect(text).toContain('`QA-<number>`');
    expect(text).toContain('cut:');
  });

  it('stays inside the cap when every author section is oversized, and names each cut', () => {
    const text = projectBrief(
      source({
        detail: { name: 'QA Sandbox', description: 'd'.repeat(9000), issuePrefix: 'QA' },
        facts: { one: 'f'.repeat(9000) },
        knowledge: [
          { slug: 's', title: 't', kind: 'overview', injection: 'always', body: 'k'.repeat(9000) },
        ],
        newestIssues: Array.from({ length: 20 }, (_, i) => ({
          key: `QA-${i}`,
          title: 'n'.repeat(500),
          status: 'open',
        })),
      }),
    );
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(text).toContain('open 5 · closed 2 · draft 1 — 8 in all.');
    expect((text.match(/cut: /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('fixtureNotApplicable (ISS-1066)', () => {
  const task = (id: string) => {
    const found = loadTasks().find((t) => t.id === id);
    if (!found) throw new Error(`no task ${id}`);
    return found;
  };

  it('names the waiting-issue task inapplicable on a project holding no waiting issue', () => {
    expect(
      fixtureNotApplicable(task('project-waiting-issue'), source({ waitingIssue: null })),
    ).toBe('the project holds no issue waiting on information');
  });

  it('leaves it applicable where the project has one', () => {
    expect(fixtureNotApplicable(task('project-waiting-issue'), source())).toBeNull();
  });

  it('names the open-issues task inapplicable on a project holding no open issue', () => {
    expect(fixtureNotApplicable(task('open-issues-linked'), source({ newestOpenIssues: [] }))).toBe(
      'the project holds no open issue',
    );
  });

  it('says nothing about a task whose fixtures the project shape cannot fail', () => {
    expect(
      fixtureNotApplicable(task('project-issue-counts'), source({ waitingIssue: null })),
    ).toBeNull();
  });
});

describe('readProjectBrief (ISS-1066)', () => {
  const bench = (over: Partial<FakeOptions> = {}) => {
    const deployment = createFakeDeployment({ script: () => ({ attempts: [] }), ...over });
    const client = createClient({ api: 'https://api.test', fetch: deployment.fetch });
    client.useToken(FAKE_TOKEN);
    return { deployment, client };
  };

  it('refuses by name, before any turn, where the credential cannot read the knowledge', async () => {
    const { deployment, client } = bench({ knowledgeStatus: 403 });
    await expect(readProjectBrief(client, FAKE_PROJECT, () => new Date())).rejects.toBeInstanceOf(
      BriefRefusal,
    );
    await expect(readProjectBrief(client, FAKE_PROJECT, () => new Date())).rejects.toThrow(
      /knowledge/,
    );
    // cm:guard the refusal is BEFORE the first turn: a run that reached a room and then failed would have spent the assistant's time and left a room to clean up
    expect(deployment.state.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('reads a project with no waiting issue as null rather than letting the refusal escape', async () => {
    const { client } = bench({ issues: [FAKE_ISSUE, FAKE_CLOSED] });
    const src = await readProjectBrief(
      client,
      FAKE_PROJECT,
      () => new Date('2026-09-17T00:00:00Z'),
    );
    expect(src.waitingIssue).toBeNull();
    expect(src.readAt).toBe('2026-09-17T00:00:00.000Z');
  });

  it('carries the effective pipeline, not the stored config keys, off a config naming only open', async () => {
    const { client } = bench({ states: ['open'] });
    const src = await readProjectBrief(client, FAKE_PROJECT, () => new Date());
    expect(src.pipelineStates).toEqual([
      'open',
      'confirmed',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'awaiting_release',
      'closed',
    ]);
  });

  it('reads the fact bodies and the always-injected knowledge bodies off the deployment', async () => {
    const { client } = bench({
      projectFacts: { 'deploy-window': 'Thursdays at 14:00 UTC.' },
      knowledge: [
        {
          slug: 'o',
          title: 'Overview',
          kind: 'overview',
          injection: 'always',
          body: 'A control plane.',
        },
        {
          slug: 'g',
          title: 'Glossary',
          kind: 'glossary',
          injection: 'on_demand',
          body: 'Never pulled.',
        },
      ],
    });
    const src = await readProjectBrief(client, FAKE_PROJECT, () => new Date());
    const text = projectBrief(src);
    expect(text).toContain('Thursdays at 14:00 UTC.');
    expect(text).toContain('A control plane.');
    // cm:guard an on-demand entry's body is NOT pulled: the brief would spend a call per entry on a project holding dozens, and those are the ones the product itself does not inject
    expect(text).not.toContain('Never pulled.');
  });

  it('lets a refusal that is not "the project has none" through, so a 403 never reads as no waiting issue', async () => {
    const { client } = bench({
      refuse: (method, path) => (method === 'GET' && path.endsWith('/issues') ? 403 : null),
    });
    await expect(readProjectBrief(client, FAKE_PROJECT, () => new Date())).rejects.toBeInstanceOf(
      DeploymentRefusal,
    );
  });
});

// cm:why this is its own case: "the grounding block is never truncated" is only true while the
// block is BOUNDED, and two of its strings are author text a tracker does not bound for us.
describe('the grounding block stays bounded (ISS-1066)', () => {
  it('keeps the counts and the pipeline when the project name and the waiting title are enormous', () => {
    const text = projectBrief(
      source({
        detail: { name: 'N'.repeat(20_000), description: null, issuePrefix: 'QA' },
        waitingIssue: { id: 'bbbb', key: 'QA-4', title: 'T'.repeat(20_000) },
      }),
    );
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(text).toContain('open 5 · closed 2 · draft 1 — 8 in all.');
    expect(text).toContain('open → confirmed → approved');
    expect(text).toContain('`QA-<number>`');
    expect(text).toContain('QA-4 — ');
  });

  it('keeps every section inside the cap when the counts map is large', () => {
    const byStatus = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`status_number_${i}`, i * 13]),
    );
    const text = projectBrief(
      source({ counts: { openCount: 5, closedCount: 2, draftCount: 1, byStatus } }),
    );
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(text).toContain('status_number_16 208');
  });
});

// cm:why the index is read twice: the route caps its response, so a large project's unfiltered index
// arrives as a prefix. Filtering that prefix for the always-injected entries finds none of the ones
// past it, and the brief reads as complete while carrying none of the project's load-bearing prose.
describe('a knowledge index the deployment capped (ISS-1066, codex F1)', () => {
  const entries = [
    { slug: 'a', title: 'A', kind: 'reference', injection: 'on_demand', body: 'filler a' },
    { slug: 'b', title: 'B', kind: 'reference', injection: 'on_demand', body: 'filler b' },
    {
      slug: 'rule',
      title: 'The house rule',
      kind: 'rule',
      injection: 'always',
      body: 'Never deploy on a Friday.',
    },
  ];

  const read = async () => {
    const deployment = createFakeDeployment({
      script: () => ({ attempts: [] }),
      knowledge: entries,
      knowledgeIndexCap: 2,
    });
    const client = createClient({ api: 'https://api.test', fetch: deployment.fetch });
    client.useToken(FAKE_TOKEN);
    return {
      deployment,
      src: await readProjectBrief(client, FAKE_PROJECT, () => new Date()),
    };
  };

  it('still carries the always-injected body that fell past the index prefix', async () => {
    const { src } = await read();
    expect(src.knowledge.map((e) => e.slug)).toEqual(['a', 'b', 'rule']);
    expect(projectBrief(src)).toContain('Never deploy on a Friday.');
  });

  it('reports nothing omitted once the recovered entry is the only one the cap had dropped', async () => {
    const { src } = await read();
    expect(src.knowledgeOmitted).toBe(0);
    expect(projectBrief(src)).not.toContain('not listed');
  });

  it('discloses what the cap left out that the filtered read did not recover', async () => {
    const deployment = createFakeDeployment({
      script: () => ({ attempts: [] }),
      knowledge: [
        ...entries,
        { slug: 'c', title: 'C', kind: 'reference', injection: 'on_demand', body: 'filler c' },
      ],
      knowledgeIndexCap: 2,
    });
    const client = createClient({ api: 'https://api.test', fetch: deployment.fetch });
    client.useToken(FAKE_TOKEN);
    const src = await readProjectBrief(client, FAKE_PROJECT, () => new Date());
    expect(src.knowledgeOmitted).toBe(1);
    expect(projectBrief(src)).toContain('1 further entry is not listed');
  });

  // cm:why recovering the row is only half of it: the knowledge section gets a share of the author
  // budget and is cut at its END, so a capped prefix of title-only entries long enough to fill that
  // share would slice away the very body the filtered read paid a request for (codex F1, round 2)
  it('renders the recovered body ahead of the title-only entries the prefix listed', () => {
    const titleOnly = Array.from({ length: 60 }, (_, i) => ({
      slug: `d${i}`,
      title: `On-demand entry ${i} ${'t'.repeat(100)}`,
      kind: 'reference',
      injection: 'on_demand',
      body: null,
    }));
    const text = projectBrief(
      source({
        knowledge: [
          ...titleOnly,
          {
            slug: 'rule',
            title: 'The house rule',
            kind: 'rule',
            injection: 'always',
            body: 'Never deploy on a Friday.',
          },
        ],
      }),
    );
    expect(titleOnly.map((e) => e.title).join('\n').length).toBeGreaterThan(BRIEF_MAX_CHARS);
    expect(text).toContain('Never deploy on a Friday.');
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
  });

  it('asks the deployment for the always-injected entries rather than filtering the prefix', async () => {
    const { deployment } = await read();
    const reads = deployment.state.requests.filter((r) => r.path.endsWith('/knowledge'));
    expect(reads).toHaveLength(2);
  });
});
