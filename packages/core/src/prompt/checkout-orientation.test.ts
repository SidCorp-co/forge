import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  read: vi.fn(),
  lessons: vi.fn(),
  guides: vi.fn(),
  orgGuides: vi.fn(),
  sources: vi.fn(),
}));
vi.mock('../knowledge/index.js', () => ({
  selectAlwaysInjectFromKnowledge: store.read,
  selectLessonEntries: store.lessons,
  selectOnDemandSlugsFromKnowledge: store.guides,
  orgOnDemandSlugsOf: store.orgGuides,
  selectOnDemandSourcesFromKnowledge: store.sources,
}));

import { LESSONS_MAP_MAX_CHARS } from '../lessons/index.js';
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
  });

  it("reads this project's always-applied entries", async () => {
    store.read.mockResolvedValue(RULES.entries);
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(store.read).toHaveBeenCalledWith('p-1');
    expect(body).toBe(
      checkoutOrientation('p-1', 'forge', {
        ...RULES,
        guides: { project: [], org: [], sources: {} },
      }),
    );
  });

  it("names the project's approved lessons beside its rules, never their sentences (ISS-867)", async () => {
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
      }),
    );
    expect(body).toContain('lesson-3 [all work]');
    expect(body).toContain('`GET /api/projects/p-1/knowledge/<slug>`');
    expect(body).not.toContain('Slice a breakdown by screen, never by table.');
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
    expect(full).not.toContain('Lesson sentence number');
    expect(full).toMatch(/and \d+ more: `GET \/api\/projects\/p-1\/knowledge\?kind=lesson/);
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
