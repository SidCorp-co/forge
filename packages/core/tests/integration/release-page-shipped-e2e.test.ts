/**
 * What QA judged short on 0.4.0-dev.218 of the release page (REQ-40 BC-4, BC-5, BC-7, BC-9, BC-11),
 * through the app's own routes against real Postgres: the verdict's note and clip reach the
 * criterion, the header counts what the list proves, what the release ships is read from its commit
 * range (answered by a fake repository), and a share and both exports carry the user view only.
 */

import {
  releasePageEmail,
  releasePageEml,
  releasePageMarkdown,
} from '@forge/contracts/release-page-export';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/integrations/llm/types.js';
import { backgroundRefreshesSettled } from '../../src/release-page/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { BUILD, releasePageWorld } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

// the gateway model, faked at the provider seam behind the same `completeOnce` a chat turn uses
const asked: ChatMessage[][] = [];
let answers: string[] = [];
register('anthropic', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(req): AsyncIterable<ChatStreamEvent> {
    asked.push(req.messages);
    yield { type: 'chunk', text: answers.shift() ?? '' };
    yield { type: 'usage', usage: { promptTokens: 90, completionTokens: 40 } };
    yield { type: 'done' };
  },
}));

// the project's repository, answered by a fake host: what each commit holds and which paths differ
const repository = vi.hoisted(() => ({
  files: {} as Record<string, Record<string, string>>,
  changed: [] as string[],
  unreachable: false,
}));
vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/source-host/index.js')>();
  return {
    ...real,
    resolveSourceHost: async () => {
      if (repository.unreachable) {
        throw new real.SourceHostUnavailable(
          'no_binding',
          'the project has no repository binding',
          null,
        );
      }
      return {
        compareFiles: async () => ({
          status: 'ahead',
          files: repository.changed,
          changes: repository.changed.map((path) => ({ path, change: 'changed' })),
        }),
        readFile: async (path: string, ref: string) =>
          repository.files[ref]?.[path] ?? { missing: `${path} does not exist at ${ref}` },
      };
    },
  };
});

let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };
const fx = releaseWorld(() => ({ projectId, ownerId }));
const world = releasePageWorld(() => ({ projectId, ownerId, call, fx }));
const { judge, releaseWorldOfFour } = world;
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  // a page read that found its highlights owed starts a refresh; none outlives its test
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  asked.length = 0;
  answers = [];
  repository.files = {};
  repository.changed = [];
  repository.unreachable = false;
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await userToken(ownerId);
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  tokens.member = await userToken(member.id);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'master');
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

function call(who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) {
  return api(tokens[who], method, `/api/projects/${projectId}${path}`, body);
}

const rows = async (query: ReturnType<typeof sql>) => [...(await db.execute(query))];

type Page = {
  view: string;
  header: {
    version: string;
    build: string | null;
    environment: { name: string | null } | null;
    verified: { level: string; proven: number; total: number };
    approval: { required: boolean; state: string; by: { name: string } | null };
  };
  highlights: {
    state: string;
    highlights?: Array<{
      claims: string[];
      media: { name: string; kind: string; url?: string } | null;
    }>;
    refusals?: Array<{ code: string }>;
    why?: string;
  };
  requirements: Array<{
    key: string;
    proven: Array<{ code: string; statement: string; short: boolean }>;
    unproven: number;
  }>;
  improvements: Array<{ issueKey: string; kind: string; line: string }>;
  fixes: Array<{ issueKey: string; kind: string; line: string }>;
  actionRequired: Array<{ kind: string; ref: string; sentence: string }>;
  knownIssues: Array<{
    bc: string | null;
    standing: string;
    reason: string | null;
    elsewhere: unknown;
  }>;
  shipped:
    | { state: 'read'; base: string; head: string; migrations: string[]; contracts: string[] }
    | { state: 'unread'; why: string };
  technical: {
    notes: Array<{ technical: string }>;
    migrations: string[];
    contracts: string[];
    dependencies: string[];
    settings: string[];
  } | null;
  can: { share: boolean; export: boolean; approve: boolean };
};

const page = async (who: keyof typeof tokens, view = 'user', version = '0.1.0') => {
  const r = await call(who, 'GET', `/releases/${version}/page?view=${view}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Page;
};

describe('the page counts what it proves once (BC-5)', () => {
  // QA 0.4.0-dev.218: "9 of 26 criteria proven" in the header beside 6 rows under the requirement.
  // Proven is `criterionCountsAsPass` everywhere: a short counts, and is marked where it is listed
  it('reads the header, the requirements list and the release record by one rule, a short counted and marked', async () => {
    const w = await releaseWorldOfFour();
    // the second issue's first criterion is passed on the build too, so every verdict is on it
    await judge(w.b, 1, 'pass', BUILD);
    const p = await page('member');
    const listed = p.requirements.flatMap((r) => r.proven);
    expect(listed.map((x) => [x.code, x.short])).toEqual([
      ['BC-1', false],
      ['BC-2', true],
      ['BC-3', false],
    ]);
    expect(p.header.verified).toMatchObject({
      proven: listed.length,
      total: 4,
      level: 'some_criteria',
    });
    const record = await call('member', 'GET', '/releases/0.1.0');
    expect((record.body.release as { verified: { proven: number } }).verified.proven).toBe(
      listed.length,
    );
    // a pass on the build in place of the short changes the mark, never the count
    await judge(w.a, 2, 'pass', BUILD);
    const after = await page('member');
    expect(after.requirements.flatMap((r) => r.proven.map((x) => x.short))).toEqual([
      false,
      false,
      false,
    ]);
    expect(after.header.verified.proven).toBe(3);
  });
});

// QA 0.4.0-dev.218: on REQ-40 Criteria the evidence row printed the issue title where the verdict's
// own evidence note belongs, with no clip or link, and the issue Criteria tab showed only the chip
describe('a criterion reaches the note and the clip its verdict kept (BC-4)', () => {
  it('reads each linked verdict with its own note and the files its evidence names that the issue keeps', async () => {
    const w = await releaseWorldOfFour();
    await judge(w.a, 1, 'pass', BUILD, {
      reason: 'Opened the release and read its version, date and approver.',
      evidence: ['reminder.webm', 'never-attached.txt'],
    });
    const detail = await call('owner', 'GET', '/requirements/REQ-1');
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const coverage = (
      detail.body as unknown as {
        standing: {
          coverage: Array<{
            code: string;
            issues: Array<{
              displayId: string;
              criterion: number;
              note: string | null;
              files: Array<{ attachmentId: string; name: string; mime: string }>;
            }>;
          }>;
        };
      }
    ).standing.coverage;
    const bc1 = coverage.find((c) => c.code === 'BC-1')?.issues[0];
    expect(bc1).toMatchObject({
      note: 'Opened the release and read its version, date and approver.',
      // the file the issue keeps is reachable by its id; a name nothing is kept under is not a link to nothing
      files: [{ attachmentId: w.clipId, name: 'reminder.webm', mime: 'video/webm' }],
    });
    // a verdict whose evidence cites nothing the issue keeps names no file, whatever note it wrote
    const bc2 = coverage.find((c) => c.code === 'BC-2')?.issues[0];
    expect(bc2).toMatchObject({ note: 'only on a desktop browser', files: [] });
    // and one that wrote no note says none, never the issue's title
    const bc4 = coverage.find((c) => c.code === 'BC-4')?.issues[0];
    expect(bc4?.note).toBe('the filter resets on reload');
    const bc3 = coverage.find((c) => c.code === 'BC-3')?.issues[0];
    expect(bc3?.note).toBeNull();
    // the file is what the criterion links to: it downloads for a member
    const file = await api(tokens.member, 'GET', `/api/attachments/${w.clipId}/download`);
    expect(file.status).toBe(200);
  });
});

// QA 0.4.0-dev.218: Action required and Technical notes read "None" because no issue filled the
// structured fields, though the release added migrations 0477 and 0478 and a new setting
describe('what the release ships is read from its commit range, not from hand-filled fields', () => {
  const PREVIOUS = 'd'.repeat(40);
  const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
  const OPENAPI = 'packages/core/contracts/forge-api.openapi.json';
  const PKG = 'packages/core/package.json';
  const COMPOSE = 'docker-compose.prod.yml';
  const journal = (...tags: string[]) =>
    JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) });
  const spec = (paths: string[]) =>
    JSON.stringify({
      paths: Object.fromEntries(paths.map((p) => [p, { get: { summary: p } }])),
      components: { schemas: {} },
    });

  // a compose file's own interpolation: `NAME: ${NAME:?why}` refuses to start without it, `${NAME:-}` does not
  const env = (name: string, tail: string) => `      ${name}: \${${name}${tail}}\n`;
  const compose = (...lines: string[]) => `services:\n  core:\n    environment:\n${lines.join('')}`;

  async function earlierRelease() {
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (gen_random_uuid(), ${projectId}, 'system', 'completed', now() - interval '2 days', '0.0.9', now() - interval '2 days',
              ${JSON.stringify({ source: 'release-batch', finish: { requestId: 'r', state: 'finished', commit: PREVIOUS, version: 1 } })}::jsonb)
    `);
  }

  function plantRange() {
    repository.changed = [JOURNAL, OPENAPI, PKG, COMPOSE];
    repository.files = {
      [PREVIOUS]: {
        [JOURNAL]: journal('0475_a', '0476_b'),
        [OPENAPI]: spec(['/api/old']),
        [PKG]: JSON.stringify({ dependencies: { hono: '4.1.0' } }),
        [COMPOSE]: compose(env('DATABASE_URL', ':?set it')),
      },
      [BUILD]: {
        [JOURNAL]: journal('0475_a', '0476_b', '0477_a_preview', '0478_a_release_page'),
        [OPENAPI]: spec(['/api/old', '/api/previews']),
        [PKG]: JSON.stringify({ dependencies: { hono: '4.2.0', zod: '4.6.5' } }),
        [COMPOSE]: compose(
          env('DATABASE_URL', ':?set it'),
          env('PREVIEW_DOMAIN', ':-'),
          env('VAULT_KEY', ':?a key'),
        ),
      },
    };
  }

  it('asks an admin for each migration the release adds and each new required setting, in the user view', async () => {
    await releaseWorldOfFour();
    await earlierRelease();
    plantRange();
    const p = await page('member', 'user');
    expect(p.shipped).toMatchObject({ state: 'read', base: PREVIOUS, head: BUILD });
    expect(p.actionRequired.map((x) => [x.kind, x.ref])).toEqual([
      ['migration', 'packages/core/drizzle/migrations/0477_a_preview.sql'],
      ['migration', 'packages/core/drizzle/migrations/0478_a_release_page.sql'],
      ['setting', 'VAULT_KEY'],
      // what an issue named of its own adds, and is not said twice
      ['migration', 'packages/core/drizzle/migrations/0999_reminders.sql'],
      ['setting', 'reminders.leadHours'],
      ['permission', 'shares.write'],
    ]);
    expect(p.actionRequired[0]?.sentence).toMatch(/^Back up the database/);
    expect(p.actionRequired[2]?.sentence).toMatch(/^Set VAULT_KEY/);
  });

  it('lists the derived migrations, contracts, dependencies and settings in the developer view', async () => {
    await releaseWorldOfFour();
    await earlierRelease();
    plantRange();
    const dev = await page('member', 'developer');
    expect(dev.technical?.migrations).toEqual([
      'packages/core/drizzle/migrations/0477_a_preview.sql',
      'packages/core/drizzle/migrations/0478_a_release_page.sql',
      'packages/core/drizzle/migrations/0999_reminders.sql',
    ]);
    expect(dev.technical?.contracts).toEqual(['added GET /api/previews']);
    expect(dev.technical?.dependencies).toEqual([
      'packages/core: added zod 4.6.5',
      'packages/core: hono 4.1.0 -> 4.2.0',
    ]);
    expect(dev.technical?.settings).toEqual(['PREVIEW_DOMAIN (optional)', 'VAULT_KEY (required)']);
  });

  it('says the range was not read, and why, where the repository cannot be reached or nothing shipped before', async () => {
    await releaseWorldOfFour();
    const first = await page('member');
    expect(first.shipped).toMatchObject({
      state: 'unread',
      why: expect.stringContaining('no release shipped before'),
    });
    await earlierRelease();
    repository.unreachable = true;
    const down = await page('member');
    expect(down.shipped).toMatchObject({
      state: 'unread',
      why: expect.stringContaining('could not be reached'),
    });
    // what the issues named still stands: an unread range adds nothing, and takes nothing away
    expect(down.actionRequired.map((x) => x.ref)).toContain(
      'packages/core/drizzle/migrations/0999_reminders.sql',
    );
  });
});

describe('a release page shared and exported carries the user view only (BC-11)', () => {
  // QA 0.4.0-dev.218: known issues on the share page and in both exports published QA's verdict
  // reasons verbatim, so technical wording reached outsiders
  it('says a known issue as the criterion and its state on the share and in both exports, the reason only in the developer view', async () => {
    await releaseWorldOfFour();
    const REASONS = ['only on a desktop browser', 'the filter resets on reload'];
    const made = await call('owner', 'POST', '/shares', {
      subjectKind: 'release',
      subjectId: '0.1.0',
      audience: 'link',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const token = String(made.body.url).split('/s/')[1];
    const [kept] = await rows(
      sql`SELECT snapshot FROM share_links WHERE project_id = ${projectId}`,
    );
    for (const reason of REASONS)
      expect(JSON.stringify((kept as { snapshot: unknown }).snapshot)).not.toContain(reason);
    // a share frozen before the user view withheld them still opens without them
    const old = JSON.parse(JSON.stringify((kept as { snapshot: unknown }).snapshot)) as Page;
    old.knownIssues = old.knownIssues.map((k) => ({
      ...k,
      reason:
        k.standing === 'short'
          ? (REASONS[0] as string)
          : k.standing === 'fail'
            ? (REASONS[1] as string)
            : null,
    }));
    // the freeze guard refuses any rewrite; stand it down for this one row, as a share frozen by an older build would simply be
    await db.execute(sql`ALTER TABLE share_links DISABLE TRIGGER USER`);
    await db.execute(
      sql`UPDATE share_links SET snapshot = ${JSON.stringify(old)}::jsonb WHERE project_id = ${projectId}`,
    );
    await db.execute(sql`ALTER TABLE share_links ENABLE TRIGGER USER`);
    const opened = await api(null, 'POST', '/api/shares/open', { token });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const shared = JSON.stringify(opened.body.release);
    for (const reason of REASONS) expect(shared).not.toContain(reason);
    const sharedPage = opened.body.release as Page;
    expect(sharedPage.knownIssues.map((k) => [k.standing, k.reason])).toEqual([
      ['short', null],
      ['not_judged', null],
      ['fail', null],
    ]);

    // the developer view carries the reasons; neither export prints them, from either view
    const dev = await page('member', 'developer');
    expect(JSON.stringify(dev.knownIssues)).toContain(REASONS[0]);
    for (const view of [dev, sharedPage]) {
      const asPage = view as unknown as Parameters<typeof releasePageMarkdown>[0];
      const email = releasePageEmail(asPage);
      const out = [
        releasePageMarkdown(asPage),
        email.text,
        email.html,
        releasePageEml(email, new Date('2026-10-09T10:00:00Z')),
      ];
      for (const text of out.slice(0, 3)) {
        for (const reason of REASONS) expect(text).not.toContain(reason);
        expect(text).toContain('criterion 2');
        expect(text).toContain('(Falls short)');
        expect(text).toContain('(Failing)');
        expect(text).toContain('(Not yet judged)');
      }
    }
  });
});
