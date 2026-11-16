// The run's map (ISS-1251): "when X → door" lines rendered from the capability cards that teach a
// run, one per family of acts or per situation of a card of none (`door-catalog.ts:tier0Map`), ranked
// by this project's calls over thirty days, as many whole blocks as the run map's budget holds. A door's detail is its card, read on its first use; the map
// is the only always-on teaching of the doors a run acts through.

import { moduleMapLines } from '../labels/index.js';
import { proposedSituations } from '../lessons/index.js';
import { doorCallsOf, doorCatalog, moduleLinesText, tier0Map } from '../lib/door-catalog.js';

export async function runDoorMap(projectId: string): Promise<string> {
  const [calls, proposed, modules] = await Promise.all([
    doorCallsOf(projectId, 30),
    proposedSituations(projectId),
    moduleMapLines(projectId),
  ]);
  const map = tier0Map(doorCatalog().doors, 'run', proposed, calls);
  const moduleText = moduleLinesText(modules, 'run');
  return `## Your map
When you meet one of these, use the door it names; before its first use, read its card (\`guides/doors.md?door=<the door>\`).
${map.text}${moduleText ? `\n\n${moduleText}` : ''}`;
}
