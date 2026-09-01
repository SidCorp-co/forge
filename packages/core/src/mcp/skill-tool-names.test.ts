/**
 * The other half of the frozen tool list: a skill that names a tool which is
 * no longer registered fails at runtime, in an agent's turn, with nothing red
 * before it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTERED_TOOLS } from './registered-tools.js';

const SKILLS_DIR = new URL('../../../runner/skills/', import.meta.url).pathname;

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

describe('bundled runner skills', () => {
  // cm:guard these skills ship INSIDE the runner binary and are never resolved from `skill_registrations`, so no server-side check sees them — this test is the only thing standing between deleting a tool and a drive job failing mid-turn on a name that no longer exists. The DB-stored skills are the other population and this cannot see them; `skills.skill_md` on the live instance is where those are checked, by hand, in the change that deletes a tool.
  it('name no MCP tool that is not registered', () => {
    const unknown: string[] = [];
    for (const file of markdownFiles(SKILLS_DIR)) {
      const body = readFileSync(file, 'utf8');
      for (const match of body.matchAll(/\bforge_[a-z_]+(?:\.[a-z_]+)?\b/g)) {
        const name = match[0];
        if (!REGISTERED_TOOLS.includes(name)) unknown.push(`${file.split('/skills/')[1]}: ${name}`);
      }
    }

    expect(
      [...new Set(unknown)],
      'these bundled skills name a tool the MCP server does not register. Either the tool was ' +
        'deleted without moving its callers, or the skill invented a name that never existed.',
    ).toEqual([]);
  });
});
