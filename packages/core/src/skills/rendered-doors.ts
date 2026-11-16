// A served skill's doors, rendered from their cards (ISS-1251): a SKILL.md names the doors it acts
// through on one marker line, and the seed replaces it with each door's card, so the skill keeps its
// method and the card stays the one copy of how a door is used. The seed hashes the rendered text, so
// a card change re-seeds every skill that renders it, as an edit of the skill itself does.

import { cardText, doorCatalog } from '../lib/door-catalog.js';
import { doorNamed } from '../guides/index.js';

/** `<!-- forge:doors PUT /api/projects/:id/knowledge/:slug | POST … -->`, on a line of its own. */
const MARKER = /^<!-- forge:doors (.+?) -->$/m;

/** The SKILL.md with its doors' cards in place of its marker; unchanged where it has none. */
export function withRenderedDoors(skillMd: string, skill: string): string {
  const found = MARKER.exec(skillMd);
  if (!found?.[1]) return skillMd;
  const catalog = doorCatalog();
  const cards = found[1].split('|').map((id) => {
    const door = doorNamed(catalog, id.trim());
    if (!door?.card) {
      throw new Error(
        `skills: ${skill}/SKILL.md renders ${id.trim()}, which this build serves no card for (skills/rendered-doors.ts)`,
      );
    }
    return cardText(door, 3);
  });
  return skillMd.replace(
    MARKER,
    `## The doors this skill acts through

Each door's card: when to reach for it, how, one worked call and the wrong way agents take.

${cards.join('\n\n')}`,
  );
}
