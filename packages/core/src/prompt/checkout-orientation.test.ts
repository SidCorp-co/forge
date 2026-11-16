import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  read: vi.fn(),
  lessons: vi.fn(),
  guides: vi.fn(),
  orgGuides: vi.fn(),
  sources: vi.fn(),
}));
const agreements = vi.hoisted(() => ({ read: vi.fn() }));
const freshness = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../lessons/index.js', async (actual) => ({
  ...(await actual<typeof import('../lessons/index.js')>()),
  cardFreshness: freshness.read,
}));
vi.mock('../agreements/index.js', async (actual) => ({
  ...(await actual<typeof import('../agreements/index.js')>()),
  readAgreements: agreements.read,
}));
const moduleLines = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../labels/index.js', () => ({ moduleMapLines: moduleLines.read }));
vi.mock('../knowledge/index.js', () => ({
  selectAlwaysInjectFromKnowledge: store.read,
  selectLessonEntries: store.lessons,
  selectOnDemandSlugsFromKnowledge: store.guides,
  orgOnDemandSlugsOf: store.orgGuides,
  selectOnDemandSourcesFromKnowledge: store.sources,
}));

import { TIER0_MODULE_LINES_MAX_CHARS } from '@forge/contracts/module-map';
import { FORGE_AGREEMENTS } from '../agreements/forge-defaults.js';
import { resolveAgreements } from '../agreements/resolve.js';
import { LESSONS_MAP_MAX_CHARS } from '../lessons/index.js';
import { moduleLinesText } from '../lib/door-catalog.js';
import {
  checkoutOrientation,
  ORIENTATION_GENERATED_LINE,
  servedCheckoutOrientation,
} from './checkout-orientation.js';
import { GUIDE_INDEX_MAX_CHARS } from './facts/guide-index.js';
import { projectRulesText } from './facts/project-rules.js';
import { OPERATING_AFFORDANCES_TEXT } from './facts/registry.js';

const UI_COPY_RULE = {
  key: 'ui-copy-rule',
  text: 'Every person-facing page reads as state, not prose.\n\n1. A label is 1-3 words.\n',
};
const DELIVERY = { key: 'dev-delivery-checks', text: 'Prove each criterion once, red first.' };
const RULES = { entries: [UI_COPY_RULE, DELIVERY] };

/** A project that changed nothing: Forge's defaults alone. */
const INHERITED = resolveAgreements({
  projectId: 'p-1',
  forge: FORGE_AGREEMENTS,
  rows: [],
  represented: [],
  task: null,
});

beforeEach(() => {
  agreements.read.mockResolvedValue(INHERITED);
  moduleLines.read.mockResolvedValue([]);
});

describe("the master's map carries one line per module (ISS-1256)", () => {
  it('names each module and the REST read of its tree, and says nothing where the project has none', () => {
    const lines = [
      {
        slug: 'execution',
        name: 'Execution',
        description: 'agent, run, master',
        terms: 2,
        rules: 1,
        openIssues: 3,
      },
    ];
    const body = checkoutOrientation('p-1', 'forge', { ...RULES, modules: lines });
    expect(body).toContain('### Modules');
    expect(body).toContain(
      '- Execution (`execution`): agent, run, master; 2 terms, 1 rules, 3 open → GET /api/projects/:id/modules/execution/map',
    );
    expect(checkoutOrientation('p-1', 'forge', { ...RULES, modules: [] })).not.toContain(
      '### Modules',
    );
  });
});

describe('every module keeps its line on the map, shortened past the cap, never dropped (ISS-1256)', () => {
  // forge-dev's twelve business modules (their purposes in English), whose whole lines overran the cap and lost four in silence
  const FORGE_DEV = [
    [
      'Adapters',
      'adapters',
      'Technical layer — outside integrations: GitHub, GitLab, Sentry, Google, LLM, mail, Rocket.Chat.',
    ],
    [
      'Conversations',
      'conversations-2',
      'Conversations & notices: assistant, conversation, chat log, notification.',
    ],
    [
      'Ecosystem',
      'ecosystem-2',
      'Ecosystem: joining many projects — contract, channel, inbound webhook.',
    ],
    [
      'Execution',
      'execution',
      'Agents & execution: agent, session, job, run, master, runner, device, skill, schedules.',
    ],
    [
      'Identity & access',
      'identity-access',
      'Identity & access: sign-in, org, membership, permission, token.',
    ],
    [
      'Knowledge',
      'knowledge-2',
      'Knowledge & memory: knowledge, memory, embeddings, guides, onboarding.',
    ],
    ['Operations', 'operations', 'Operations & measuring: metrics, usage, health, admin.'],
    [
      'Platform',
      'platform',
      'Technical layer — platform: DB, outbox, queue, MCP, WebSocket, middleware; every group uses it.',
    ],
    [
      'Product design',
      'product-design',
      'Product design: requirement, workflow, mockup, proposal, feedback.',
    ],
    [
      'Projects & config',
      'projects-config',
      'Projects & config: project, configuration, secrets, preferences.',
    ],
    [
      'Release & deploy',
      'release-deploy',
      'Release & deploy: release batching, branches, git, Coolify deploys, versions.',
    ],
    [
      'Work & delivery',
      'work-delivery',
      'Work: issue, status lifecycle, pipeline, questions, PM, comment, defect intake.',
    ],
  ].map(([name, slug, description]) => ({
    name: name as string,
    slug: slug as string,
    description: description as string,
    terms: 0,
    rules: 0,
    openIssues: 0,
  }));
  const linesOf = (text: string) => text.split('\n').filter((l) => l.startsWith('- '));

  it.each(['master', 'run', 'bot'] as const)(
    'carries all twelve of forge-dev for a %s, within the cap',
    (audience) => {
      const text = moduleLinesText(FORGE_DEV, audience);
      const lines = linesOf(text);
      expect(
        lines.map((l) => /\(`([^`]+)`\)/.exec(l)?.[1]),
        'a module line was dropped',
      ).toEqual(FORGE_DEV.map((m) => m.slug));
      expect(lines.join('\n').length).toBeLessThanOrEqual(TIER0_MODULE_LINES_MAX_CHARS);
      expect(text, 'a purpose ends in its own stop before the counts').not.toMatch(/[.;:,];/);
      expect(text).toContain(audience === 'bot' ? '`module.get <slug>`' : '/modules/<slug>/map');
    },
  );

  it('ends a whole purpose without its own stop before the counts', () => {
    const [execution] = linesOf(moduleLinesText(FORGE_DEV.slice(3, 4), 'master'));
    expect(execution).toBe(
      '- Execution (`execution`): Agents & execution: agent, session, job, run, master, runner, device, skill, schedules; 0 terms, 0 rules, 0 open → GET /api/projects/:id/modules/execution/map',
    );
  });

  it('counts what cannot fit even bare, and names the door that lists them', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...(FORGE_DEV[0] as (typeof FORGE_DEV)[number]),
      name: `Module ${i}`,
      slug: `module-${i}`,
    }));
    const lines = linesOf(moduleLinesText(many, 'master'));
    const shown = lines.length - 1;
    expect(lines.at(-1)).toBe(`- ${80 - shown} more modules: GET /api/projects/:id/modules/map`);
    expect(shown).toBeGreaterThan(0);
    expect(lines.join('\n').length).toBeLessThanOrEqual(TIER0_MODULE_LINES_MAX_CHARS);
    expect(linesOf(moduleLinesText(many, 'bot')).at(-1)).toMatch(/ more modules: module\.pillar$/);
  });
});

describe('core serves the orientation a box writes into a checkout', () => {
  const body = checkoutOrientation('p-1', 'forge', RULES);

  it('opens the way the runner recognises a generated orientation (orientation.rs:is_generated)', () => {
    expect(body.startsWith('# Forge orientation — forge\n')).toBe(true);
    expect(body.split('\n').slice(0, 4)).toContain(ORIENTATION_GENERATED_LINE);
  });

  it('carries the one affordances table pipeline prompts carry, so the two cannot drift', () => {
    expect(body).toContain(OPERATING_AFFORDANCES_TEXT);
    expect(body.match(/## Operating affordances/g)).toHaveLength(1);
  });

  it('names its project, and is byte-identical for the same project and rules', () => {
    expect(body).toContain('**projectId:** `p-1`');
    expect(checkoutOrientation('p-1', 'forge', RULES)).toBe(body);
    expect(checkoutOrientation('p-2', 'forge', RULES)).not.toBe(body);
  });
});

describe('a run a master declares on a box reads the rules a core-built prompt carries (REQ-43 BC-12)', () => {
  it('carries every always-applied knowledge entry verbatim under its slug, in the order read', () => {
    const body = checkoutOrientation('p-1', 'forge', RULES);
    expect(body).toContain(`### ui-copy-rule\n${UI_COPY_RULE.text}`);
    expect(body).toContain(`### dev-delivery-checks\n${DELIVERY.text}`);
    expect(body.indexOf('### ui-copy-rule')).toBeLessThan(body.indexOf('### dev-delivery-checks'));
    expect(body.match(/## Project rules \(always applied\)/g)).toHaveLength(1);
  });

  it('renders the block the preamble renders, one heading level up', () => {
    const body = checkoutOrientation('p-1', 'forge', RULES);
    expect(body).toContain(projectRulesText(RULES.entries, 2).trimEnd());
    expect(projectRulesText([DELIVERY], 3)).toBe(
      '### Project rules (always applied)\n\nHard rules for this project — always-injected by the project owner. Follow them exactly.\n\n#### dev-delivery-checks\nProve each criterion once, red first.',
    );
    expect(body.endsWith('Prove each criterion once, red first.\n')).toBe(true);
  });

  it('carries no rules heading for a project with no always-applied entry', () => {
    const body = checkoutOrientation('p-1', 'forge', { entries: [] });
    expect(body).not.toContain('Project rules');
    expect(body.endsWith(`${OPERATING_AFFORDANCES_TEXT}\n`)).toBe(true);
  });

  it('says where to read the rules when the knowledge store could not be read', () => {
    const body = checkoutOrientation('p-1', 'forge', { unreadable: true });
    expect(body).toContain('## Project rules (always applied)');
    expect(body).toContain('could not be read');
    expect(body).toContain('`GET /api/projects/p-1/knowledge?injection=always`');
  });
});

describe('the orientation core serves reads the rules from the knowledge store', () => {
  beforeEach(() => {
    store.read.mockReset();
    store.lessons.mockReset().mockResolvedValue([]);
    store.guides.mockReset().mockResolvedValue([]);
    store.orgGuides.mockReset().mockResolvedValue([]);
    store.sources.mockReset().mockResolvedValue({});
    freshness.read.mockReset().mockResolvedValue([]);
  });

  // ISS-1251: the card ledger is read beside the knowledge store; its failure loses the proposed
  // rows of the affordances table, never the project's rules
  it('serves the rules when only the card ledger cannot be read', async () => {
    store.read.mockResolvedValue(RULES.entries);
    freshness.read.mockRejectedValue(new Error('card ledger down'));
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(body).not.toContain('could not be read');
    expect(body).toContain(RULES.entries[0]?.text as string);
    expect(body).toBe(
      checkoutOrientation('p-1', 'forge', {
        ...RULES,
        guides: { project: [], org: [], sources: {} },
        agreements: INHERITED,
      }),
    );
  });

  it("reads this project's always-applied entries", async () => {
    store.read.mockResolvedValue(RULES.entries);
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(store.read).toHaveBeenCalledWith('p-1');
    expect(body).toBe(
      checkoutOrientation('p-1', 'forge', {
        ...RULES,
        guides: { project: [], org: [], sources: {} },
        agreements: INHERITED,
        proposed: new Map(),
      }),
    );
  });

  it("shows a situation this project's lesson folded into an orientation card as proposed, and no other project's (ISS-1251)", async () => {
    store.read.mockResolvedValue([]);
    const delta = (projectId: string | null, text: string, field = 'situation') => ({
      id: text,
      field,
      op: 'add',
      text,
      replaces: null,
      fromLesson: 'L-4',
      projectId,
      at: '2026-11-16T00:00:00Z',
    });
    freshness.read.mockResolvedValue([
      {
        cardId: 'POST /api/memory',
        recheckOwed: null,
        scenarios: [],
        proposedDeltas: [
          delta('p-1', 'A gotcha a later run would hit again'),
          delta('p-2', 'Another project only'),
          delta(null, 'Every project learned this'),
          delta('p-1', 'Not a situation', 'practice'),
        ],
      },
    ]);
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(body).toMatch(
      /\| \(proposed\) A gotcha a later run would hit again \| [^|]*memory -X POST[^|]* \| \|/,
    );
    expect(body).toContain('| (proposed) Every project learned this |');
    expect(body).not.toContain('Another project only');
    expect(body).not.toContain('Not a situation');
    expect(checkoutOrientation('p-1', 'forge', RULES)).not.toContain('(proposed)');
  });

  it("names the project's approved lessons beside its rules, each with when it applies and its gist (ISS-867, ISS-1251)", async () => {
    store.read.mockResolvedValue(RULES.entries);
    const lesson = {
      slug: 'lesson-3',
      sentence: 'Slice a breakdown by screen, never by table.',
      meta: {
        lessonId: 'l3',
        number: 3,
        scope: { kind: 'project' as const, areaId: null, areaName: null, itemKind: null },
      },
    };
    store.lessons.mockResolvedValue([lesson]);
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(store.lessons).toHaveBeenCalledWith('p-1');
    expect(body).toBe(
      checkoutOrientation('p-1', 'forge', {
        ...RULES,
        lessons: [lesson],
        guides: { project: [], org: [], sources: {} },
        agreements: INHERITED,
      }),
    );
    expect(body).toContain('When any work:\n- lesson-3: ');
    expect(body).toContain('`GET /api/projects/p-1/knowledge/<slug>`');
    expect(body).toContain('- lesson-3: Slice a breakdown by screen, never by table.');
  });

  it("names the project's and its org's on-demand guides, the org's marked, read through the project door", async () => {
    store.read.mockResolvedValue(RULES.entries);
    store.guides.mockResolvedValue(['deploy-notes', 'ui-copy-rule']);
    store.orgGuides.mockResolvedValue(['org-voice-guide']);
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(store.orgGuides).toHaveBeenCalledWith('p-1');
    expect(body).toContain('## Project guides (fetch on demand)');
    expect(body).toContain(
      '- deploy-notes — source: none recorded\n- org-voice-guide (org) — source: none recorded',
    );
    expect(body).toContain('`forge-runner api projects/p-1/knowledge/<slug>`');
    // an always-applied entry is carried whole, so the index does not name it again
    expect(body).not.toContain('- ui-copy-rule');
  });

  it('shows what each named guide rests on, cut to one short line (ISS-1064)', async () => {
    store.read.mockResolvedValue([]);
    store.guides.mockResolvedValue(['deploy-notes', 'release-steps']);
    store.orgGuides.mockResolvedValue(['org-voice-guide']);
    const long = `packages/core/src/release/${'x'.repeat(200)}.ts:cut`;
    store.sources.mockResolvedValue({
      'deploy-notes': 'scripts/deploy.sh:main, ISS-12',
      'release-steps': long,
      'org-voice-guide': 'REQ-50 BC-3',
    });
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(store.sources).toHaveBeenCalledWith('p-1');
    expect(body).toContain('- deploy-notes — source: scripts/deploy.sh:main, ISS-12\n');
    expect(body).toContain('- org-voice-guide (org) — source: REQ-50 BC-3');
    const line = body.split('\n').find((l) => l.startsWith('- release-steps'));
    expect(line).toBe(`- release-steps — source: ${long.slice(0, 79)}…`);
  });

  it('stays a map within its budget however many lessons and guides there are', async () => {
    const lessons = Array.from({ length: 500 }, (_, i) => ({
      slug: `lesson-${i + 1}`,
      sentence: `Lesson sentence number ${i + 1}, which is long enough to matter in a prompt.`,
      meta: {
        lessonId: `l${i}`,
        number: i + 1,
        scope: { kind: 'project' as const, areaId: null, areaName: null, itemKind: null },
      },
    }));
    const project = Array.from({ length: 300 }, (_, i) => `project-guide-number-${i}`);
    const org = Array.from({ length: 300 }, (_, i) => `org-guide-number-${i}`);
    const bare = checkoutOrientation('p-1', 'forge', RULES);
    const full = checkoutOrientation('p-1', 'forge', {
      ...RULES,
      lessons,
      guides: {
        project,
        org,
        sources: Object.fromEntries(
          [...project, ...org].map((slug) => [slug, `packages/core/src/${'y'.repeat(300)}.ts`]),
        ),
      },
    });
    expect(full.length - bare.length).toBeLessThanOrEqual(
      LESSONS_MAP_MAX_CHARS + GUIDE_INDEX_MAX_CHARS + 4,
    );
    expect(full).toContain(
      'When any work:\n- lesson-500: Lesson sentence number 500, which is long',
    );
    expect(full).toMatch(/\d+ more lessons, nearer other work: `GET …\/knowledge\?kind=lesson/);
    expect(full).toMatch(
      /- and \d+ more: `forge-runner api projects\/p-1\/knowledge\?injection=on_demand`/,
    );
  });

  it('serves a named absence, not a failed read, when the store throws', async () => {
    store.read.mockRejectedValueOnce(new Error('connection refused'));
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(body).toBe(checkoutOrientation('p-1', 'forge', { unreadable: true }));
  });
});

describe('a fresh session reads the working agreements in force (REQ-90 BC-5, BC-13)', () => {
  it('carries the map of every default, and points a rule an agreement restates at it', async () => {
    store.read.mockResolvedValue([{ key: 'batch-delivery', text: 'Work moves in batches.' }]);
    store.guides.mockResolvedValue([]);
    store.orgGuides.mockResolvedValue([]);
    store.sources.mockResolvedValue({});
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(agreements.read).toHaveBeenCalledWith('p-1', null);
    expect(body).toContain('## Working agreements');
    for (const a of FORGE_AGREEMENTS) expect(body).toContain(`- **${a.name}**`);
    expect(body).toContain('`lean-testing`');
    expect(body).toContain('### batch-delivery (detail of the working agreement Batch delivery)');
    expect(body.indexOf('## Working agreements')).toBeLessThan(body.indexOf('## Project rules'));
  });
});
