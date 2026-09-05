import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// cm:guard the ONLY assertion that the eight staged skill bodies stay deleted. Migration 0208 removes 178 `skills` rows and 182 `skill_registrations`, but `seedBuiltinSkills` upserts every `forge-*` directory under this root on EVERY boot — so restoring one directory silently restores its rows one deploy later, and no other check in the repo would notice.
const STAGED_SKILL_NAMES = [
  'forge-triage',
  'forge-clarify',
  'forge-plan',
  'forge-code',
  'forge-review',
  'forge-test',
  'forge-fix',
  'forge-release',
  'forge-staging',
] as const;

function shippedSkillsRoot(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

describe('the staged lane ships no skill body (ISS-895)', () => {
  it('no staged skill directory survives under packages/core/skills', async () => {
    const entries = await readdir(shippedSkillsRoot(), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(dirs.filter((d) => (STAGED_SKILL_NAMES as readonly string[]).includes(d))).toEqual([]);
  });

  it('the surviving directories are the ones the autonomous lane and its operators still use', async () => {
    const entries = await readdir(shippedSkillsRoot(), { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([
      'forge-onboard',
      'forge-product-map',
      'forge-reconcile',
      'forge-skills',
      'forge-verify-skill',
    ]);
  });

  it('every remaining skill directory holds a SKILL.md the seeder can read', async () => {
    const root = shippedSkillsRoot();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const files = await readdir(path.join(root, entry.name));
      expect(files).toContain('SKILL.md');
    }
  });
});
