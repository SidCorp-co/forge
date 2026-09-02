import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// cm:guard mirrors `defaultSkillsRoot()` in builtin-seed.ts — the seeded bodies live at `<pkg-root>/skills/`, and a wrong root here reads as every body still carrying the rule
const SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));

// cm:why a plan records the branch that was taken; the branches weighed and dropped survive only if the plan carries them, because Forge keeps the issue rather than the conversation (ISS-883)
// cm:guard this holds the SPECIFICATION only — that the seeded body still asks for the section. Whether a given plan's rejected branches are real is prose, and nothing here can read it
const SECTION = 'Rejected alternatives';

const BODIES = ['forge-plan/SKILL.md', 'forge-plan/references/plan-format.md'];

describe('builtin seed skills: the plan keeps what it rejected', () => {
  it.each(BODIES)('%s still asks for the section', async (rel) => {
    const body = await readFile(path.join(SKILLS_ROOT, rel), 'utf8');
    expect(body).toContain(SECTION);
  });
});
