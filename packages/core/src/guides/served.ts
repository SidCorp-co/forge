// A guide as it is served (ISS-1251): its method, then the card of each door it acts through,
// rendered from the door catalog, so a door is taught in one place and every page that names it
// reads the same card. `doors.md` is the page of every door by the situation that calls for it.

import type { CardAudience } from '@forge/contracts/capability-cards';
import {
  cardText,
  type DoorCatalog,
  doorCatalog,
  doorNames,
  tier0Map,
} from '../lib/door-catalog.js';
import type { ForgeGuide } from './types.js';

/**
 * The catalog door a guide or a reader names: an MCP action, a REST write, a REST twin of one, or the
 * capability name a Tier-0 map gives it (`issues.merge`).
 */
export function doorNamed(catalog: DoorCatalog, id: string) {
  const names = doorNames(catalog.doors);
  return catalog.doors.find(
    (d) => d.id === id || d.twins?.includes(id) || d.card?.id === id || names.get(d.id) === id,
  );
}

/** The guide's body with the cards of the doors it acts through beneath it. */
export function servedGuideBody(guide: Pick<ForgeGuide, 'slug' | 'body' | 'doors'>): string {
  if (!guide.doors?.length) return guide.body;
  const catalog = doorCatalog();
  const cards = guide.doors.map((id) => {
    const door = doorNamed(catalog, id);
    if (!door) {
      throw new Error(
        `guide ${guide.slug}: it acts through ${id}, which this build serves no door as (guides/served.ts)`,
      );
    }
    return cardText(door, 3);
  });
  return `${guide.body.trimEnd()}

## The doors this guide acts through

Each door's card: when to reach for it, how, one worked call and the wrong way agents take.

${cards.join('\n\n')}
`;
}

/**
 * The guide list as a guide body (ISS-1307): the MCP reads it as `guide:index`, so a reader carrying
 * that name onto REST asks for `guides/index.md`. Rendered from the registry `GET /api/guides` lists,
 * so it names exactly the guides served; each link is relative, so it resolves under either mount.
 */
export function guideIndexBody(
  guides: readonly Pick<ForgeGuide, 'slug' | 'title' | 'summary'>[],
): string {
  return `# Forge guides

Every guide core serves; read one as \`GET /api/guides/<slug>.md\`. The same list as JSON: \`GET /api/guides\`.

${guides.map((g) => `- [${g.title}](${g.slug}.md): ${g.summary}`).join('\n')}
`;
}

/** Every door a card teaches, by audience and situation; the doors no card teaches yet are counted. */
export function doorsPage(catalog: DoorCatalog): string {
  const taught = catalog.doors.filter((d) => d.card);
  const audiences = ['run', 'master', 'bot', 'person'] as const;
  const sections = audiences.map((a) => {
    const lines = taught.flatMap((d) =>
      (d.card?.situations ?? [])
        .filter((s) => d.card?.audience.includes(a) && (!s.for || s.for.includes(a)))
        .map((s) => `- when ${s.when} → \`${d.id}\``),
    );
    return `## For a ${a}\n\n${lines.join('\n')}`;
  });
  return `# Doors

Every door an agent acts through, by the situation that calls for it. A door's card, with its
practice, one worked call and the wrong way agents take: \`guides/doors.md?door=<door>\`.

${sections.join('\n\n')}

${catalog.doors.length - taught.length} of ${catalog.doors.length} doors carry no card yet.
`;
}

/**
 * One audience's Tier-0 map (ISS-1251): a line per situation, "when X → the door", the page a master's
 * skill points at, so the situations a master meets are rendered from the cards by the core its box
 * talks to rather than written into the skill a runner release ships.
 */
export function audienceMapPage(catalog: DoorCatalog, audience: CardAudience): string {
  return `# Your map (${audience})

When you meet one of these, use the door it names; before its first use, read its card
(\`guides/doors.md?door=<the door>\`).

${tier0Map(catalog.doors, audience).text}
`;
}
