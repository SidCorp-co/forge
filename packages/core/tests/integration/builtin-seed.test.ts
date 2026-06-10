import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { skills } from '../../src/db/schema.js';
import { seedBuiltinSkills } from '../../src/skills/builtin-seed.js';
import { hashSkillBody } from '../../src/skills/hash.js';
import { type TestDatabase, setupTestDatabase, truncateAll } from '../helpers/index.js';

const SKILL_A = `---
name: forge-sample-a
description: "sample A"
user_invocable: true
---
body A v1
`;

const SKILL_A_V2 = `---
name: forge-sample-a
description: "sample A — edited"
user_invocable: true
---
body A v2
`;

const SKILL_B = `---
name: forge-sample-b
description: "sample B"
---
body B
`;

async function writeSkill(root: string, name: string, contents: string) {
  const dir = path.join(root, name);
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), contents, 'utf8');
}

describe('seedBuiltinSkills', () => {
  let harness: TestDatabase;
  let skillsRoot: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    skillsRoot = await mkdtemp(path.join(tmpdir(), 'forge-skills-'));
  }, 60_000);

  afterAll(async () => {
    if (skillsRoot) await rm(skillsRoot, { recursive: true, force: true });
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    // Reset the skills directory between tests.
    await rm(skillsRoot, { recursive: true, force: true });
    skillsRoot = await mkdtemp(path.join(tmpdir(), 'forge-skills-'));
  });

  it('inserts each builtin skill on first run with scope=global, source=builtin, version=1', async () => {
    await writeSkill(skillsRoot, 'forge-sample-a', SKILL_A);
    await writeSkill(skillsRoot, 'forge-sample-b', SKILL_B);

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot });

    expect(result).toMatchObject({ inserted: 2, updated: 0, unchanged: 0 });

    const rows = await harness.db
      .select({
        name: skills.name,
        scope: skills.scope,
        source: skills.source,
        version: skills.version,
      })
      .from(skills);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.scope).toBe('global');
      expect(r.source).toBe('builtin');
      expect(r.version).toBe(1);
    }
  });

  it('is idempotent: a second run with unchanged files produces all unchanged', async () => {
    await writeSkill(skillsRoot, 'forge-sample-a', SKILL_A);
    await writeSkill(skillsRoot, 'forge-sample-b', SKILL_B);

    await seedBuiltinSkills(harness.db as never, { skillsRoot });
    const second = await seedBuiltinSkills(harness.db as never, { skillsRoot });
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
  });

  it('updates on content change and bumps version + content_hash', async () => {
    await writeSkill(skillsRoot, 'forge-sample-a', SKILL_A);
    await writeSkill(skillsRoot, 'forge-sample-b', SKILL_B);
    await seedBuiltinSkills(harness.db as never, { skillsRoot });

    const [before] = await harness.db
      .select({ version: skills.version, contentHash: skills.contentHash })
      .from(skills)
      .where(and(eq(skills.name, 'forge-sample-a'), eq(skills.scope, 'global')));

    await writeSkill(skillsRoot, 'forge-sample-a', SKILL_A_V2);
    const second = await seedBuiltinSkills(harness.db as never, { skillsRoot });
    expect(second).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });

    const [after] = await harness.db
      .select({
        version: skills.version,
        contentHash: skills.contentHash,
        description: skills.description,
      })
      .from(skills)
      .where(and(eq(skills.name, 'forge-sample-a'), eq(skills.scope, 'global')));

    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.contentHash).not.toBe(before?.contentHash);
    expect(after?.description).toBe('sample A — edited');
  });

  it('ignores non-builtin directories (must start with forge-)', async () => {
    await writeSkill(skillsRoot, 'custom-deploy', SKILL_A);
    await writeSkill(skillsRoot, 'forge-sample-b', SKILL_B);

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot });
    expect(result.inserted).toBe(1);
  });

  it('throws when frontmatter is missing required fields', async () => {
    await writeSkill(skillsRoot, 'forge-broken', '---\ndescription: only desc\n---\nbody');
    await expect(seedBuiltinSkills(harness.db as never, { skillsRoot })).rejects.toThrow(/name/);
  });

  it('seeds every bundled forge-* / shop-* skill from the real package directory', async () => {
    // Use the real `packages/core/skills/` root — ensures the shipped files parse
    // and the seeder works end-to-end without the tmp-dir fixture. Derive the
    // expected set from disk so adding a new builtin skill does not break this.
    // The seeder seeds BOTH `forge-` (core pipeline) and `shop-` (Epodsystem
    // storefront) prefixes — see BUILTIN_SKILL_PREFIXES in builtin-seed.ts.
    const realRoot = new URL('../../skills/', import.meta.url).pathname;
    const dirents = await readdir(realRoot, { withFileTypes: true });
    const expectedNames = dirents
      .filter((d) => d.isDirectory() && (d.name.startsWith('forge-') || d.name.startsWith('shop-')))
      .map((d) => d.name)
      .sort();
    expect(expectedNames.length).toBeGreaterThan(0);

    const result = await seedBuiltinSkills(harness.db as never, { skillsRoot: realRoot });
    expect(result.inserted).toBe(expectedNames.length);

    const rows = await harness.db.select({ name: skills.name }).from(skills).orderBy(skills.name);
    expect(rows.map((r) => r.name).sort()).toEqual(expectedNames);
  });

  it('loads non-empty files[] for skills that ship a references/ folder (AC #3)', async () => {
    // forge-plan and forge-test both ship reference docs; after seeding their
    // global rows must carry those files (previously always empty).
    const realRoot = new URL('../../skills/', import.meta.url).pathname;
    await seedBuiltinSkills(harness.db as never, { skillsRoot: realRoot });

    for (const name of ['forge-plan', 'forge-test']) {
      const [row] = await harness.db
        .select({ files: skills.files, contentHash: skills.contentHash, skillMd: skills.skillMd })
        .from(skills)
        .where(and(eq(skills.name, name), eq(skills.scope, 'global')));
      const files = (row?.files ?? []) as Array<{ path: string; encoding: string }>;
      expect(files.length).toBeGreaterThan(0);
      // Every shipped reference lives under references/ and is utf8 text.
      expect(files.every((f) => f.encoding === 'utf8')).toBe(true);
      expect(files.some((f) => f.path.startsWith('references/'))).toBe(true);
      // contentHash is computed over skillMd + files (hashSkillBody parity).
      expect(hashSkillBody(row!.skillMd as string, row!.files)).toBe(row?.contentHash);
    }
  });
});
