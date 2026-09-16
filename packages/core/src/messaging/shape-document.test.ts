// The shape document and the tables it describes, pinned to each other.
//
// The document is served live over the MCP prompt channel and is the only place
// an agent can read the whole contract before it writes. A rule, a cell or a
// door the document does not name is one an agent meets for the first time in
// a refusal — which is the failure this whole issue is about, moved one level
// up (ISS-997).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { MANAGED_META_SKILLS } = await import('../skills/effective.js');

import { registeredCells } from './cells.js';
import { DOORS } from './doors.js';

const SKILL_NAME = 'forge-message-shape';
const DOC = readFileSync(
  fileURLToPath(new URL(`../../skills/${SKILL_NAME}/SKILL.md`, import.meta.url)),
  'utf8',
);

const ruleIds = [...new Set(registeredCells().flatMap((c) => c.rules.map((r) => r.id)))].sort();

describe('the shape document', () => {
  it('is served over the MCP prompt channel, not synced to disk', () => {
    expect(MANAGED_META_SKILLS).toContain(SKILL_NAME);
  });

  it('carries the manifest the seeder needs to serve it at all', () => {
    expect(DOC.startsWith('---\n')).toBe(true);
    expect(DOC).toMatch(new RegExp(`^name: ${SKILL_NAME}$`, 'm'));
    expect(DOC).toMatch(/^description: "/m);
  });

  it.each(ruleIds)('names the rule `%s`', (id) => {
    expect(DOC).toContain(`\`${id}\``);
  });

  it.each(registeredCells().map((c) => c.id))('names the cell `%s`', (id) => {
    expect(DOC).toContain(`\`${id}\``);
  });

  it.each(DOORS.map((d) => d.id))('names the door `%s`', (id) => {
    expect(DOC).toContain(`\`${id}\``);
  });

  it.each(DOORS.map((d) => [d.id, d.ending] as const))(
    'gives `%s` the ending it actually declares (%s)',
    (id, ending) => {
      const row = DOC.split('\n').find((l) => l.startsWith(`| \`${id}\` |`));
      expect(row, `no table row for ${id}`).toBeTruthy();
      expect(row).toContain(ending);
    },
  );

  it.each(DOORS.filter((d) => d.ending === 'fallback').map((d) => [d.id, d.repairs] as const))(
    'gives `%s` the repair count it actually declares (%s)',
    (id, repairs) => {
      const row = DOC.split('\n').find((l) => l.startsWith(`| \`${id}\` |`));
      expect(row).toContain(`| ${repairs} |`);
    },
  );

  it('says which cell is reserved, rather than leaving a reader to find no door for it', () => {
    for (const c of registeredCells().filter((c) => c.reserved)) {
      expect(DOC).toMatch(new RegExp(`\`${c.id}\`[^\\n]*reserved|reserved[^\\n]*\`${c.id}\``, 'i'));
    }
  });

  it('tells an agent there is no vocabulary to learn', () => {
    expect(DOC).toMatch(/never about what tags it is made of/i);
  });

  it('tells an agent nothing will rewrite what it wrote', () => {
    expect(DOC).toMatch(/carries \*\*no message text\*\*/i);
  });
});
