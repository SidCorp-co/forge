import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the logger so test output stays quiet and we can assert calls.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// db/client touches env at import time; stub the env it reads. The seeder
// itself only consumes the `Db` we pass in, so the mocked `db` export is
// irrelevant — the test passes a hand-rolled mock.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));

vi.mock('../db/client.js', () => ({ db: {} }));

const { seedBuiltinSkills } = await import('./builtin-seed.js');

interface MockSkillRow {
  contentHash: string;
  version: number;
  skillMd: string | null;
}

// Hand-rolled `Db` mock that satisfies only the chained calls the seeder uses:
// select().from().where().limit() (read existing row) and insert().values()
// + update().set().where(). Each call returns a thenable that resolves to the
// recorded value, mirroring drizzle's runtime shape.
function makeDb(initialRows: Map<string, MockSkillRow>) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: unknown; set: Record<string, unknown> }> = [];
  const rows = new Map(initialRows);

  let pendingInsertValues: Record<string, unknown> | null = null;
  let pendingUpdateSet: Record<string, unknown> | null = null;

  // `where` receives a Drizzle SQL expression we can't introspect, so we
  // identify rows by the most recent select target. The seeder always reads
  // by (name, scope='global') — the test feeds `currentName` explicitly so
  // the chain knows which row to return.
  let currentName: string | null = null;

  const selectChain = {
    from() {
      return selectChain;
    },
    where() {
      return selectChain;
    },
    async limit(_n: number) {
      if (!currentName) return [];
      const row = rows.get(currentName);
      return row ? [row] : [];
    },
  };

  const db = {
    select(_cols?: unknown) {
      // Reset the name pointer; the seeder sets it via `eq(skills.name, name)`
      // which we cannot intercept — instead, the test runs one skill at a time
      // and sets `currentName` before invoking the seeder for that skill.
      return selectChain;
    },
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          pendingInsertValues = v;
          inserts.push(v);
          // Return a thenable resolving to undefined (Drizzle's normal shape).
          return Promise.resolve();
        },
      };
    },
    update(_table: unknown) {
      return {
        set(v: Record<string, unknown>) {
          pendingUpdateSet = v;
          return {
            where(w: unknown) {
              updates.push({ set: v, where: w });
              if (currentName) {
                const existing = rows.get(currentName);
                if (existing) {
                  rows.set(currentName, {
                    contentHash: (v.contentHash as string) ?? existing.contentHash,
                    version: (v.version as number) ?? existing.version,
                    skillMd: (v.skillMd as string) ?? existing.skillMd,
                  });
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return {
    db,
    inserts,
    updates,
    rows,
    setCurrentName(name: string) {
      currentName = name;
    },
    _pendingInsertValues: () => pendingInsertValues,
    _pendingUpdateSet: () => pendingUpdateSet,
  };
}

async function makeSkillsRoot(skills: Array<{ name: string; body: string; description?: string }>) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-seed-'));
  for (const s of skills) {
    const dir = path.join(root, s.name);
    mkdirSync(dir, { recursive: true });
    const desc = s.description ?? `desc for ${s.name}`;
    const md = `---\nname: ${s.name}\ndescription: "${desc}"\n---\n\n${s.body}\n`;
    await writeFile(path.join(dir, 'SKILL.md'), md, 'utf8');
  }
  return root;
}

let cleanupRoots: string[] = [];

beforeEach(() => {
  cleanupRoots = [];
});

afterEach(async () => {
  for (const r of cleanupRoots) await rm(r, { recursive: true, force: true });
});

async function track(root: string) {
  cleanupRoots.push(root);
  return root;
}

describe('seedBuiltinSkills', () => {
  it('inserts a fresh row, populates skillMd, and emits an "inserted" change record', async () => {
    const root = await track(
      await makeSkillsRoot([{ name: 'forge-alpha', body: '# Alpha body' }]),
    );
    const harness = makeDb(new Map());
    harness.setCurrentName('forge-alpha');

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.changes).toHaveLength(1);
    const [change] = result.changes;
    expect(change?.reason).toBe('inserted');
    expect(change?.name).toBe('forge-alpha');
    expect(change?.oldVersion).toBe(0);
    expect(change?.newVersion).toBe(1);
    expect(typeof change?.contentHash).toBe('string');
    expect(change?.contentHash.length).toBeGreaterThan(10);

    expect(harness.inserts).toHaveLength(1);
    const inserted = harness.inserts[0]!;
    expect(inserted.name).toBe('forge-alpha');
    expect(inserted.scope).toBe('global');
    expect(inserted.skillMd).toContain('# Alpha body');
    expect(inserted.contentHash).toBe(change?.contentHash);
  });

  it('treats matching contentHash + non-null skillMd as unchanged (no change record)', async () => {
    const root = await track(
      await makeSkillsRoot([{ name: 'forge-beta', body: '# Beta body' }]),
    );
    // First seed gets the hash; reuse it for the unchanged case.
    const seedHarness = makeDb(new Map());
    seedHarness.setCurrentName('forge-beta');
    const first = await seedBuiltinSkills(seedHarness.db as never, { skillsRoot: root });
    const expectedHash = first.changes[0]?.contentHash;
    expect(expectedHash).toBeDefined();

    const harness = makeDb(
      new Map([
        [
          'forge-beta',
          { contentHash: expectedHash!, version: 3, skillMd: 'previously-stored' },
        ],
      ]),
    );
    harness.setCurrentName('forge-beta');

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.changes).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(harness.updates).toHaveLength(0);
  });

  it('backfills stale skillMd without bumping version and without emitting a change', async () => {
    const root = await track(
      await makeSkillsRoot([{ name: 'forge-gamma', body: '# Gamma body' }]),
    );
    const seedHarness = makeDb(new Map());
    seedHarness.setCurrentName('forge-gamma');
    const first = await seedBuiltinSkills(seedHarness.db as never, { skillsRoot: root });
    const expectedHash = first.changes[0]?.contentHash;

    // Stale row: hash matches but skillMd is empty/null (older builds).
    const harness = makeDb(
      new Map([
        ['forge-gamma', { contentHash: expectedHash!, version: 5, skillMd: null }],
      ]),
    );
    harness.setCurrentName('forge-gamma');

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    expect(result.updated).toBe(1);
    expect(result.changes).toHaveLength(0);
    expect(harness.updates).toHaveLength(1);
    const updateSet = harness.updates[0]?.set;
    // Version stays at 5 (no logical change), skillMd is filled in.
    expect(updateSet?.version).toBe(5);
    expect(updateSet?.skillMd).toContain('# Gamma body');
  });

  it('bumps version and emits an "updated" change record when contentHash differs', async () => {
    const root = await track(
      await makeSkillsRoot([{ name: 'forge-delta', body: '# Delta v2 body' }]),
    );
    const harness = makeDb(
      new Map([
        [
          'forge-delta',
          { contentHash: 'old-stale-hash', version: 7, skillMd: 'old md' },
        ],
      ]),
    );
    harness.setCurrentName('forge-delta');

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    expect(result.updated).toBe(1);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.reason).toBe('updated');
    expect(change.oldVersion).toBe(7);
    expect(change.newVersion).toBe(8);
    expect(change.contentHash).not.toBe('old-stale-hash');
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]?.set.version).toBe(8);
  });

  it('skips entries that do not start with the forge- prefix', async () => {
    const root = await track(
      await makeSkillsRoot([
        { name: 'forge-epsilon', body: 'body' },
        { name: 'other-skill', body: 'irrelevant' },
      ]),
    );
    const harness = makeDb(new Map());
    harness.setCurrentName('forge-epsilon');

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    // Only the prefixed dir was processed.
    expect(result.inserted).toBe(1);
    expect(harness.inserts).toHaveLength(1);
    expect(harness.inserts[0]?.name).toBe('forge-epsilon');
  });
});
