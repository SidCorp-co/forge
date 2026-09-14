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

// cm:guard `effective.ts` is imported for ONE constant and reaches `db/client.ts` on the way, which reads the environment at module load. Mocking the client keeps this a test about two tables agreeing; without it the suite fails on a missing DATABASE_URL and says nothing about the document.
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
  // cm:guard the assertion is on MANAGED_META_SKILLS and not on a route, because that constant IS the delivery decision: it is what `resolveManagedMetaPrompts` reads and what keeps the document off the device disk sync. A copy on disk would be the version an agent reads while core refuses it by a newer one.
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

  // cm:guard a door's ENDING is the half an agent plans around — whether a refusal is the last word or something gets posted anyway — so naming the door while misstating its ending would be worse than omitting it.
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

  // cm:guard the document must not become the second copy of the vocabulary the fleet just deleted. It says a rule is about what a message CLAIMS; a version of it listing tags to include would be the `forge-*` prefix set returning under a new name, which is the one outcome the issue names as failure.
  it('tells an agent there is no vocabulary to learn', () => {
    expect(DOC).toMatch(/never about what tags it is made of/i);
  });

  it('tells an agent nothing will rewrite what it wrote', () => {
    expect(DOC).toMatch(/carries \*\*no message text\*\*/i);
  });
});
