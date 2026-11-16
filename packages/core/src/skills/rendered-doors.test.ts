import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DoorCatalog, provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { seededSkillMd } from './builtin-seed.js';
import { hashSkillBody } from './hash.js';
import { withRenderedDoors } from './rendered-doors.js';

const PRODUCT_MAP = readFileSync(
  new URL('../../skills/forge-product-map/SKILL.md', import.meta.url),
  'utf8',
);
const KNOWLEDGE_WRITE = 'PUT /api/projects/:id/knowledge/:slug';

const serve = (catalog: () => DoorCatalog) =>
  provideDoorCatalog({ doorCatalog: catalog, doorCalls: async () => new Map() });

describe("a served skill's doors are rendered from their cards (ISS-1251)", () => {
  it('puts each named door’s card where the skill names it, and keeps no marker', () => {
    serve(servedDoorCatalog);
    const rendered = withRenderedDoors(PRODUCT_MAP, 'forge-product-map');
    const card = servedDoorCatalog().doors.find((d) => d.card?.id === KNOWLEDGE_WRITE)?.card;
    expect(card).toBeDefined();
    expect(rendered).toContain('## The doors this skill acts through');
    expect(rendered).toContain(card?.purpose ?? '?');
    expect(rendered).not.toContain('<!-- forge:doors');
    // a skill naming no door is seeded as it is written
    expect(withRenderedDoors('# no doors\n', 'x')).toBe('# no doors\n');
  });

  it('refuses by name a door this build serves no card for', () => {
    serve(servedDoorCatalog);
    expect(() => withRenderedDoors('<!-- forge:doors POST /api/nowhere -->\n', 'forge-x')).toThrow(
      'forge-x/SKILL.md renders POST /api/nowhere, which this build serves no card for',
    );
  });

  it('hashes what it rendered, so a card change re-seeds the skill', () => {
    serve(servedDoorCatalog);
    const before = hashSkillBody(seededSkillMd(PRODUCT_MAP, 'forge-product-map'), []);
    const served = servedDoorCatalog();
    const edited: DoorCatalog = {
      ...served,
      doors: served.doors.map((d) =>
        d.card?.id === KNOWLEDGE_WRITE && d.card
          ? { ...d, card: { ...d.card, purpose: `${d.card.purpose} Edited.` } }
          : d,
      ),
    };
    serve(() => edited);
    const after = hashSkillBody(seededSkillMd(PRODUCT_MAP, 'forge-product-map'), []);
    serve(servedDoorCatalog);
    expect(after).not.toBe(before);
  });
});
