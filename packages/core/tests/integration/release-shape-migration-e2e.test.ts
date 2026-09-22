import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-1189 — migration 0301 runs against the real table, on every shape a row can hold.
 *
 * Three of this change's claims are claims about what Postgres wrote and nothing else can see
 * them: the shape derived from a stored `environments.preview`, the `autoProdDeploy` reading
 * carried onto `states.awaiting_release.mode`, and the abort on a preview side that names live's
 * host. Each turns on values the TypeScript side never meets — a jsonb null, a preview that is not
 * an object, an `agent_config` with no `states` map at all.
 *
 * The suite replays the actual `.sql` after putting the table back the way 0301 found it, which is
 * what `environments-migration-e2e.test.ts` does for 0279. That rewind is also what makes the abort
 * case meaningful: an aborted run must leave the column absent and every row unwritten, which is a
 * claim about the SCHEMA and not only about contents.
 */
let harness: TestDatabase;
let forward: string[];
let ownerId: string;
let orgId: string;

async function statements(path: string): Promise<string[]> {
  const text = await readFile(new URL(path, import.meta.url), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The pre-0301 state: no column, and no `mode` under the release stage. Idempotent, because an
 *  aborted run leaves the column already absent and the next test must fail on its own subject. */
async function rewind(): Promise<void> {
  await harness.db.execute(sql`ALTER TABLE projects DROP COLUMN IF EXISTS preview_shape`);
  await harness.db.execute(sql`
    UPDATE projects
       SET agent_config = agent_config #- '{pipelineConfig,states,awaiting_release,mode}'
     WHERE agent_config IS NOT NULL
  `);
}

async function runForward(): Promise<void> {
  for (const statement of forward) await harness.db.execute(sql.raw(statement));
}

async function forwardError(): Promise<string | null> {
  try {
    await runForward();
    return null;
  } catch (err) {
    const parts: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
    return parts.join('\n');
  }
}

async function seed(slug: string, environments: unknown, agentConfig?: unknown): Promise<string> {
  const project = await createTestProject(harness.db, ownerId, { orgId, slug });
  await harness.db.execute(
    environments === undefined
      ? sql`UPDATE projects SET environments = NULL WHERE id = ${project.id}`
      : sql`UPDATE projects SET environments = ${JSON.stringify(environments)}::jsonb WHERE id = ${project.id}`,
  );
  if (agentConfig !== undefined) {
    await harness.db.execute(
      sql`UPDATE projects SET agent_config = ${JSON.stringify(agentConfig)}::jsonb WHERE id = ${project.id}`,
    );
  }
  return project.id;
}

async function shapeOf(id: string): Promise<unknown> {
  const rows = (await harness.db.execute(
    sql`SELECT preview_shape AS v FROM projects WHERE id = ${id}`,
  )) as unknown as { v: unknown }[];
  return rows[0]?.v;
}

async function releaseModeOf(id: string): Promise<unknown> {
  const rows = (await harness.db.execute(sql`
    SELECT agent_config -> 'pipelineConfig' -> 'states' -> 'awaiting_release' ->> 'mode' AS v
      FROM projects WHERE id = ${id}
  `)) as unknown as { v: unknown }[];
  return rows[0]?.v;
}

async function columnExists(): Promise<boolean> {
  const rows = (await harness.db.execute(sql`
    SELECT 1 AS v FROM information_schema.columns
     WHERE table_name = 'projects' AND column_name = 'preview_shape'
  `)) as unknown as { v: unknown }[];
  return rows.length > 0;
}

const LIVE_ONLY = {
  preview: null,
  live: { url: 'https://app.example.com', apiUrl: 'https://api.example.com' },
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  forward = await statements('../../drizzle/migrations/0301_a_project_declares_its_shape.sql');
}, 120_000);

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  await rewind();
  const owner = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  ownerId = owner.id;
  orgId = (await seedOrg(harness.db, ownerId)).id;
});

describe('the shape each project is given', () => {
  it('derives `deployed` from a preview side that names a host', async () => {
    const id = await seed('p-deployed', {
      preview: { url: 'https://staging.example.com', apiUrl: null },
      live: { url: 'https://app.example.com' },
    });
    await runForward();
    expect(await shapeOf(id)).toBe('deployed');
  });

  it('derives `deployed` from a preview side carried only by a labelled testing row', async () => {
    const id = await seed('p-rows', {
      preview: { url: null, apiUrl: null, urls: [{ label: 'QA', url: 'https://qa.example.com' }] },
      live: { url: 'https://app.example.com' },
    });
    await runForward();
    expect(await shapeOf(id)).toBe('deployed');
  });

  it('derives `local` from a preview side that is the JSON literal null', async () => {
    const id = await seed('p-null-preview', LIVE_ONLY);
    await runForward();
    expect(await shapeOf(id)).toBe('local');
  });

  it('derives `local` from a preview object whose three fields are all empty', async () => {
    const id = await seed('p-empty-preview', {
      preview: { url: null, apiUrl: null, urls: [] },
      live: { url: 'https://app.example.com' },
    });
    await runForward();
    expect(await shapeOf(id)).toBe('local');
  });

  it('derives `local` from an environments column holding SQL null', async () => {
    const id = await seed('p-no-environments', undefined);
    await runForward();
    expect(await shapeOf(id)).toBe('local');
  });

  it('derives `local` from an environments value that is not an object at all', async () => {
    const id = await seed('p-scalar', 'not-an-object');
    await runForward();
    expect(await shapeOf(id)).toBe('local');
  });
});

describe('the release declaration carried over from autoProdDeploy', () => {
  it('writes `auto` where the old key was true, so nothing stops releasing', async () => {
    const id = await seed('p-auto', LIVE_ONLY, {
      pipelineConfig: { enabled: true, autoProdDeploy: true, states: { open: { enabled: true } } },
    });
    await runForward();
    expect(await releaseModeOf(id)).toBe('auto');
  });

  it('builds the states map where the project stored none', async () => {
    const id = await seed('p-auto-no-states', LIVE_ONLY, {
      pipelineConfig: { enabled: true, autoProdDeploy: true },
    });
    await runForward();
    expect(await releaseModeOf(id)).toBe('auto');
  });

  it('keeps the rest of the stage it writes into', async () => {
    const id = await seed('p-auto-stage', LIVE_ONLY, {
      pipelineConfig: {
        enabled: true,
        autoProdDeploy: true,
        states: { awaiting_release: { enabled: true, model: 'sonnet' } },
      },
    });
    await runForward();
    const rows = (await harness.db.execute(sql`
      SELECT agent_config -> 'pipelineConfig' -> 'states' -> 'awaiting_release' AS v
        FROM projects WHERE id = ${id}
    `)) as unknown as { v: unknown }[];
    expect(rows[0]?.v).toEqual({ enabled: true, model: 'sonnet', mode: 'auto' });
  });

  it('writes nothing where the old key was false', async () => {
    const id = await seed('p-manual', LIVE_ONLY, {
      pipelineConfig: { enabled: true, autoProdDeploy: false },
    });
    await runForward();
    expect(await releaseModeOf(id)).toBeNull();
  });

  it('writes nothing where the project has no pipeline config', async () => {
    const id = await seed('p-no-pipeline', LIVE_ONLY, { personaStyle: 'plain' });
    await runForward();
    expect(await releaseModeOf(id)).toBeNull();
  });

  it('leaves an explicitly declared manual alone, so a replay cannot undo it', async () => {
    const id = await seed('p-explicit-manual', LIVE_ONLY, {
      pipelineConfig: {
        enabled: true,
        autoProdDeploy: true,
        states: { awaiting_release: { enabled: true, mode: 'manual' } },
      },
    });
    await runForward();
    expect(await releaseModeOf(id)).toBe('manual');
  });

  it('aborts on a JSON-null states, which would swallow the carry-over in silence', async () => {
    await seed('p-null-states', LIVE_ONLY, {
      pipelineConfig: { enabled: true, autoProdDeploy: true, states: null },
    });
    const message = await forwardError();
    expect(message).toContain('p-null-states');
    expect(message).toContain('ISS-1189');
  });

  it('aborts on a JSON-null awaiting_release for the same reason', async () => {
    await seed('p-null-stage', LIVE_ONLY, {
      pipelineConfig: { enabled: true, autoProdDeploy: true, states: { awaiting_release: null } },
    });
    expect(await forwardError()).toContain('p-null-stage');
  });

  it('leaves a project alone whose states is null but which does not release automatically', async () => {
    const id = await seed('p-null-states-manual', LIVE_ONLY, {
      pipelineConfig: { enabled: true, autoProdDeploy: false, states: null },
    });
    expect(await forwardError()).toBeNull();
    expect(await releaseModeOf(id)).toBeNull();
  });
});

describe('a stored preview side that names live’s host', () => {
  /** forge-dev's own value, as it stood until 2026-09-22. */
  const FORGE_DEV_BEFORE_THE_FIX = {
    preview: {
      url: 'https://forge-beta.sidcorp.co',
      apiUrl: 'https://forge-beta-api.sidcorp.co',
      urls: [{ label: 'Beta Version (Staging Here)', url: 'https://forge-beta.sidcorp.co' }],
    },
    live: {
      url: 'https://forge-beta.sidcorp.co',
      apiUrl: 'https://forge-beta-api.sidcorp.co',
      commitUrl: 'https://forge-beta-api.sidcorp.co/health',
      commitPath: 'sourceCommit',
    },
  };

  it('aborts rather than deriving a shape for it', async () => {
    await seed('forge-dev-before-the-fix', FORGE_DEV_BEFORE_THE_FIX);
    expect(await forwardError()).toContain('ISS-1189');
  });

  it('names the project by slug', async () => {
    await seed('forge-dev-before-the-fix', FORGE_DEV_BEFORE_THE_FIX);
    expect(await forwardError()).toContain('forge-dev-before-the-fix');
  });

  it('names the host the two sides share', async () => {
    await seed('forge-dev-before-the-fix', FORGE_DEV_BEFORE_THE_FIX);
    expect(await forwardError()).toContain('forge-beta.sidcorp.co');
  });

  it('leaves the column absent, so no row is written under a half-applied schema', async () => {
    await seed('forge-dev-before-the-fix', FORGE_DEV_BEFORE_THE_FIX);
    await forwardError();
    expect(await columnExists()).toBe(false);
  });

  it('catches a collision carried only by a labelled testing row', async () => {
    await seed('p-labelled-collision', {
      preview: {
        url: 'https://staging.example.com',
        urls: [{ label: 'Staging Here', url: 'https://app.example.com/admin' }],
      },
      live: { url: 'https://app.example.com' },
    });
    expect(await forwardError()).toContain('p-labelled-collision');
  });

  it('catches a collision the two sides spell differently — an explicit :443 against none', async () => {
    await seed('p-default-port', {
      preview: { url: 'https://app.example.com:443' },
      live: { url: 'https://app.example.com' },
    });
    expect(await forwardError()).toContain('p-default-port');
  });

  it('catches a collision hidden behind credentials in the authority', async () => {
    await seed('p-userinfo', {
      preview: { url: 'https://qa:secret@app.example.com' },
      live: { url: 'https://app.example.com' },
    });
    expect(await forwardError()).toContain('p-userinfo');
  });

  it('lets a preview side on a different port through, which is a different address', async () => {
    const id = await seed('p-other-port', {
      preview: { url: 'https://app.example.com:8443' },
      live: { url: 'https://app.example.com' },
    });
    expect(await forwardError()).toBeNull();
    expect(await shapeOf(id)).toBe('deployed');
  });

  it('lets a preview side on its own host through', async () => {
    const id = await seed('p-separate-hosts', {
      preview: { url: 'https://staging.example.com', apiUrl: 'https://api.staging.example.com' },
      live: { url: 'https://app.example.com', apiUrl: 'https://api.example.com' },
    });
    expect(await forwardError()).toBeNull();
    expect(await shapeOf(id)).toBe('deployed');
  });
});
