import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSkillBody } from './hash.js';

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

/** Write a file (text or binary Buffer) at a relative path inside a skill dir. */
async function writeSkillFile(
  root: string,
  skillName: string,
  relPath: string,
  data: string | Buffer,
) {
  const abs = path.join(root, skillName, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
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
    const root = await track(await makeSkillsRoot([{ name: 'forge-alpha', body: '# Alpha body' }]));
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
    const root = await track(await makeSkillsRoot([{ name: 'forge-beta', body: '# Beta body' }]));
    // First seed gets the hash; reuse it for the unchanged case.
    const seedHarness = makeDb(new Map());
    seedHarness.setCurrentName('forge-beta');
    const first = await seedBuiltinSkills(seedHarness.db as never, { skillsRoot: root });
    const expectedHash = first.changes[0]?.contentHash;
    expect(expectedHash).toBeDefined();

    const harness = makeDb(
      new Map([
        ['forge-beta', { contentHash: expectedHash!, version: 3, skillMd: 'previously-stored' }],
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
    const root = await track(await makeSkillsRoot([{ name: 'forge-gamma', body: '# Gamma body' }]));
    const seedHarness = makeDb(new Map());
    seedHarness.setCurrentName('forge-gamma');
    const first = await seedBuiltinSkills(seedHarness.db as never, { skillsRoot: root });
    const expectedHash = first.changes[0]?.contentHash;

    // Stale row: hash matches but skillMd is empty/null (older builds).
    const harness = makeDb(
      new Map([['forge-gamma', { contentHash: expectedHash!, version: 5, skillMd: null }]]),
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
      new Map([['forge-delta', { contentHash: 'old-stale-hash', version: 7, skillMd: 'old md' }]]),
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

  it('walks references/ + scripts/ into files[] with POSIX-relative paths and utf8 content', async () => {
    const root = await track(await makeSkillsRoot([{ name: 'forge-zeta', body: '# Zeta' }]));
    await writeSkillFile(root, 'forge-zeta', 'references/guide.md', '# Guide\nline two\n');
    await writeSkillFile(root, 'forge-zeta', 'scripts/run.sh', '#!/bin/sh\necho hi\n');
    const harness = makeDb(new Map());
    harness.setCurrentName('forge-zeta');

    await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    const files = harness.inserts[0]?.files as Array<{
      path: string;
      content: string;
      encoding: string;
    }>;
    expect(files).toBeDefined();
    // Sorted by path for hash stability.
    expect(files.map((f) => f.path)).toEqual(['references/guide.md', 'scripts/run.sh']);
    expect(files.every((f) => f.encoding === 'utf8')).toBe(true);
    expect(files[0]?.content).toBe('# Guide\nline two\n');
    // SKILL.md itself is never duplicated into files[].
    expect(files.some((f) => f.path === 'SKILL.md')).toBe(false);
  });

  it('encodes binary files (NUL byte) as base64', async () => {
    const root = await track(await makeSkillsRoot([{ name: 'forge-eta', body: '# Eta' }]));
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    await writeSkillFile(root, 'forge-eta', 'assets/logo.png', bin);
    const harness = makeDb(new Map());
    harness.setCurrentName('forge-eta');

    await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    const files = harness.inserts[0]?.files as Array<{
      path: string;
      content: string;
      encoding: string;
    }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.encoding).toBe('base64');
    expect(Buffer.from(files[0]!.content, 'base64').equals(bin)).toBe(true);
  });

  it('computes contentHash via hashSkillBody(rawText, files)', async () => {
    const root = await track(await makeSkillsRoot([{ name: 'forge-theta', body: '# Theta' }]));
    await writeSkillFile(root, 'forge-theta', 'references/r.md', 'ref body\n');
    const harness = makeDb(new Map());
    harness.setCurrentName('forge-theta');

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: root });

    const inserted = harness.inserts[0]!;
    const expected = hashSkillBody(inserted.skillMd as string, inserted.files);
    expect(inserted.contentHash).toBe(expected);
    expect(result.changes[0]?.contentHash).toBe(expected);
  });

  it('is idempotent: a second seed over an unchanged folder leaves the row unchanged', async () => {
    const root = await track(await makeSkillsRoot([{ name: 'forge-iota', body: '# Iota' }]));
    await writeSkillFile(root, 'forge-iota', 'references/r.md', 'ref body\n');

    const first = makeDb(new Map());
    first.setCurrentName('forge-iota');
    const firstResult = await seedBuiltinSkills(first.db as never, { skillsRoot: root });
    const hash = firstResult.changes[0]!.contentHash;
    const skillMd = first.inserts[0]!.skillMd as string;

    // Second run with the row already persisted (hash matches, skillMd present).
    const second = makeDb(new Map([['forge-iota', { contentHash: hash, version: 4, skillMd }]]));
    second.setCurrentName('forge-iota');
    const secondResult = await seedBuiltinSkills(second.db as never, { skillsRoot: root });

    expect(secondResult.unchanged).toBe(1);
    expect(secondResult.updated).toBe(0);
    expect(secondResult.changes).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
  });

  it('bumps version when a folder file is added/edited (hash changes)', async () => {
    const root = await track(await makeSkillsRoot([{ name: 'forge-kappa', body: '# Kappa' }]));
    await writeSkillFile(root, 'forge-kappa', 'references/r.md', 'ref body\n');

    const first = makeDb(new Map());
    first.setCurrentName('forge-kappa');
    const firstResult = await seedBuiltinSkills(first.db as never, { skillsRoot: root });
    const oldHash = firstResult.changes[0]!.contentHash;
    const skillMd = first.inserts[0]!.skillMd as string;

    // Add a second reference file between runs → folder content changes → hash differs.
    await writeSkillFile(root, 'forge-kappa', 'references/extra.md', 'new file\n');

    const second = makeDb(
      new Map([['forge-kappa', { contentHash: oldHash, version: 4, skillMd }]]),
    );
    second.setCurrentName('forge-kappa');
    const secondResult = await seedBuiltinSkills(second.db as never, { skillsRoot: root });

    expect(secondResult.updated).toBe(1);
    expect(secondResult.changes).toHaveLength(1);
    expect(secondResult.changes[0]?.newVersion).toBe(5);
    expect(secondResult.changes[0]?.contentHash).not.toBe(oldHash);
    expect(second.updates[0]?.set.version).toBe(5);
    const updatedFiles = second.updates[0]?.set.files as Array<{ path: string }>;
    expect(updatedFiles.map((f) => f.path)).toEqual(['references/extra.md', 'references/r.md']);
  });
});
