// The run's map (ISS-1251): "when X → door" lines rendered from the capability cards that teach a
// run, one per family of acts or per situation of a card of none (`door-catalog.ts:tier0Map`), ranked
// by this project's calls over thirty days, as many whole blocks as the run map's budget holds. A door's detail is its card, read on its first use; the map
// is the only always-on teaching of the doors a run acts through.

import { cardFreshness } from '../lessons/index.js';
import { doorCallsOf, doorCatalog, tier0Map } from '../lib/door-catalog.js';

/** By card id, the situations this project's lessons folded into a card its code does not carry yet. */
async function proposedOf(projectId: string): Promise<Map<string, string[]>> {
  return new Map(
    (await cardFreshness()).map((f) => [
      f.cardId,
      f.proposedDeltas
        .filter(
          (d) => d.field === 'situation' && (d.projectId === null || d.projectId === projectId),
        )
        .map((d) => d.text),
    ]),
  );
}

export async function runDoorMap(projectId: string): Promise<string> {
  const [calls, proposed] = await Promise.all([doorCallsOf(projectId, 30), proposedOf(projectId)]);
  const map = tier0Map(doorCatalog().doors, 'run', proposed, calls);
  return `## Your map
When you meet one of these, use the door it names; before its first use, read its card (\`guides/doors.md?door=<the door>\`).
${map.text}${map.carried.length < map.reach ? `\nMore doors, each by its situation: \`guides/doors.md\`.` : ''}`;
}
