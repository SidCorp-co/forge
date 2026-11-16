// The doors agents are given (ISS-1251), as one catalog every reader takes from the same place: the
// MCP actions the registry serves and the REST routes the published API contract lists. The MCP door
// builds it and the composition root hands it here, so a read model or another door counts and checks
// against it without importing the MCP door, and nobody keeps a list of doors by hand.

import {
  type CapabilityCard,
  type CardAudience,
  situationsFor,
  TIER0_MAP_MAX_CHARS,
} from '@forge/contracts/capability-cards';
import { CARD_FAMILIES } from '@forge/contracts/card-families';
import type { DoorSurface } from '@forge/contracts/door-use';
import { type ModuleMapLine, TIER0_MODULE_LINES_MAX_CHARS } from '@forge/contracts/module-map';
import { portSlot } from './port-slot.js';

/** One door: what it is called, where it is served, what it is for and the feature that owns it. */
export interface CatalogDoor {
  /** `<door>.<action>` (MCP) or `METHOD /path` with the contract's `:param` template (REST). */
  id: string;
  surface: DoorSurface;
  /** One line from the door's own guide; null where the source holds none. */
  summary: string | null;
  /** The MCP tool and its REST twin, or the route's resource (`/api/projects/:id/feedback`). */
  feature: string;
  /** What teaches the door: its capability card, where one is written (ISS-1251). */
  card?: CapabilityCard;
  /** The repository paths its door lives in (a file or a module's directory); empty where unknown. */
  paths?: readonly string[];
  /**
   * The REST writes that do this door's act (`POST /api/forge/feedback/doors` for `feedback.door`):
   * one act, one card, so a call through either counts on this door.
   */
  twins?: readonly string[];
}

export interface DoorCatalog {
  doors: readonly CatalogDoor[];
  /** The door a logged call names, or null where the catalog holds none for it. */
  doorOf(call: { tool: string; action: string | null }): CatalogDoor | null;
  /** Whether a logged call reached its door through a REST twin rather than the door itself. */
  viaTwin(call: { tool: string; action: string | null }): boolean;
}

interface DoorCatalogPorts {
  doorCatalog(): DoorCatalog;
  /** This project's calls per door over the last `days`, which ranks a Tier-0 map (the door use read). */
  doorCalls(projectId: string, days: number): Promise<ReadonlyMap<string, number>>;
}
const slot = portSlot<DoorCatalogPorts>('door-catalog', 'provideDoorCatalog');
export const provideDoorCatalog = slot.provide;
export const doorCatalog = (): DoorCatalog => slot.get().doorCatalog();
export const doorCallsOf = (projectId: string, days: number) =>
  slot.get().doorCalls(projectId, days);

/** The paths a card's door lives in: a landing touching one owes the card a re-check. */
export const cardPaths = (cardId: string): readonly string[] =>
  doorCatalog().doors.find((d) => d.card?.id === cardId)?.paths ?? [];

/** One audience's Tier-0 map: its text, the cards it carries, and how many cards teach that audience. */
export interface Tier0Map {
  text: string;
  /** The card ids the map carries; every other card of the audience is Tier 1 (found by situation). */
  carried: readonly string[];
  reach: number;
}

/** The name a REST door's act takes where its module has an MCP tool by another name. */
const MODULE_PREFIX: Readonly<Record<string, string>> = {
  feedback: 'project_feedback',
  'integration-door': 'integration',
  'project-config': 'config',
  'release-batch': 'releases',
};
const METHOD_VERB: Readonly<Record<string, string>> = {
  PUT: 'set',
  PATCH: 'edit',
  DELETE: 'delete',
};

/**
 * Each door's capability name, the way an MCP action is named (`issues.merge`): an action keeps its
 * own id, and a REST door takes its owning module and its act, the last literal segment of its path
 * (the one before it where the last is the module's own resource, `comments.requirements`), led by
 * its method's verb where it is not a POST (`issues.set_criteria`). Two doors one name would take
 * are told apart by the segment before (`requirements.revisions_accept`), or by the scope it
 * is in where an action already holds the name (`issues.create_in_project`). The map names this;
 * the card the agent opens carries the route.
 */
export function doorNames(doors: readonly CatalogDoor[]): ReadonlyMap<string, string> {
  const derived = doors.map((d) => {
    if (d.surface !== 'rest' || !d.card) return { d, name: d.id, alt: d.id, scoped: d.id };
    const owner = d.card.owner;
    const prefix = MODULE_PREFIX[owner] ?? owner.replace(/-/g, '_');
    const [method = 'POST', path = ''] = d.id.split(' ');
    const literals = path
      .split('/')
      .filter((p) => p && p !== 'api' && !p.startsWith(':'))
      .map((p) => p.replace(/-/g, '_'));
    const own = (l: string | undefined) =>
      l !== undefined &&
      [owner.replace(/-/g, '_'), `${owner}s`, `${owner}es`, prefix].some(
        (o) => o.replace(/-/g, '_') === l,
      );
    let act = literals.at(-1);
    if (own(act)) act = literals.at(-2) === 'projects' ? undefined : literals.at(-2);
    const verb = METHOD_VERB[method] ?? (act ? '' : 'create');
    const name = (a: string | undefined) =>
      `${prefix}.${[verb, a].filter((x) => x && !own(x)).join('_') || 'create'}`;
    const before = literals.at(-2);
    const scope = literals[0] && !own(literals[0]) ? literals[0].replace(/s$/, '') : null;
    return {
      d,
      name: name(act),
      // two doors one name: the segment before tells them apart, else the scope the door is in
      alt: before && !own(before) && before !== 'projects' ? name(`${before}_${act}`) : name(act),
      scoped: `${name(act)}${scope ? `_in_${scope}` : ''}`,
    };
  });
  const tally = (names: readonly string[]) => {
    const count = new Map<string, number>();
    for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
    return (n: string) => (count.get(n) ?? 0) > 1;
  };
  const first = tally(derived.map((x) => x.name));
  const second = derived.map((x) => (first(x.name) ? x.alt : x.name));
  const still = tally(second);
  return new Map(
    derived.map((x, i) => [x.d.id, still(second[i] as string) ? x.scoped : (second[i] as string)]),
  );
}

/**
 * A family's doors on one line, each tool written once before its first act (`issues.merge · move ·
 * close`), so the line names every door and repeats no tool.
 */
function doorsLine(names: readonly string[]): string {
  const toolOf = (n: string) => n.split('.')[0] ?? n;
  const tools = [...new Set(names.map(toolOf))];
  return tools
    .map((t) => {
      const acts = names.filter((n) => toolOf(n) === t).map((n) => n.slice(t.length + 1));
      return `${t}.${acts.join(' · ')}`;
    })
    .join(' · ');
}

/** The line a map ends on where it could not carry every card: how many, and where to find them. */
export const moreLine = (left: number) =>
  `- ${left} more: forge_find { query: "<your situation>" } or guides/doors.md`;

/**
 * The Tier-0 map of one audience (ISS-1251 criterion 5: a cap triggers merging, never truncation): the
 * cards that teach it, most used first (`calls`, the door use of the window), each named by its
 * capability (`doorNames`). A card of a family (`card-families.ts`) is one name on its family's
 * line, "when <the family's situation> → its names"; a card of none gives each situation a line.
 * Whole blocks are carried within `TIER0_MAP_MAX_CHARS`; where they cannot all be, the map is a pile
 * due for merging and its last line says how many it left out and where they are found.
 */
export function tier0Map(
  doors: readonly CatalogDoor[],
  audience: CardAudience,
  proposed: ReadonlyMap<string, readonly string[]> = new Map(),
  calls: ReadonlyMap<string, number> = new Map(),
): Tier0Map {
  const taught = doors
    .filter(
      (d) => d.card?.audience.includes(audience) && situationsFor(d.card, audience).length > 0,
    )
    .sort((a, b) => (calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const names = doorNames(doors);
  const nameOf = (d: CatalogDoor) => names.get(d.id) ?? d.id;
  // one block per family, ranked by its most used door, and one per card of none
  const groups = new Map<string, CatalogDoor[]>();
  for (const d of taught) {
    const key = d.card?.family ?? `door:${d.id}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const blocks = [...groups.values()].map((members) => {
    const cards = members.map((d) => d.card as CapabilityCard);
    const family = cards[0]?.family;
    return {
      ids: cards.map((c) => c.id),
      lines: [
        ...(family
          ? [`- when ${CARD_FAMILIES[family]} → ${doorsLine(members.map(nameOf))}`]
          : situationsFor(cards[0] as CapabilityCard, audience).map(
              (s) => `- when ${s.when} → ${nameOf(members[0] as CatalogDoor)}`,
            )),
        // a situation a lesson folded in, shown until the card's code carries it
        ...members.flatMap((d) =>
          (proposed.get(d.card?.id ?? '') ?? []).map((t) => `- (proposed) ${t} → ${nameOf(d)}`),
        ),
      ],
    };
  });
  const fill = (cap: number) => {
    const lines: string[] = [];
    const carried: string[] = [];
    let size = -1;
    for (const b of blocks) {
      const grows = b.lines.join('\n').length + 1;
      if (size + grows > cap) continue;
      size += grows;
      lines.push(...b.lines);
      carried.push(...b.ids);
    }
    return { lines, carried };
  };
  const whole = fill(TIER0_MAP_MAX_CHARS);
  if (whole.carried.length === taught.length) {
    return { text: whole.lines.join('\n'), carried: whole.carried, reach: taught.length };
  }
  // the pointer to the cards left out is within the cap too, so room is kept for it
  const kept = fill(TIER0_MAP_MAX_CHARS - moreLine(taught.length).length - 1);
  return {
    text: [...kept.lines, moreLine(taught.length - kept.carried.length)].join('\n'),
    carried: kept.carried,
    reach: taught.length,
  };
}

/**
 * One door's card as Tier 1 reads it (ISS-1251): what it is for, each situation and what to do in it,
 * how to use it well, one worked call and the wrong way agents take. Every page that teaches a door
 * renders it from here, so the card is the one copy.
 */
export function cardText(door: CatalogDoor, depth = 3): string {
  const card = door.card;
  const heading = `${'#'.repeat(depth)} \`${door.id}\``;
  if (!card) return `${heading}\n\nNo card is written for this door yet.`;
  const also = door.twins?.length
    ? `\n\nThe same act over REST: ${door.twins.map((t) => `\`${t}\``).join(', ')}.`
    : '';
  const situations = card.situations.map(
    (s) =>
      `- When ${s.when}: ${s.do.replace(/\.$/, '')}.${s.watch ? ` Watch: ${s.watch.replace(/\.$/, '')}.` : ''}${
        s.for ? ` (${s.for.join(', ')})` : ''
      }`,
  );
  return [
    `${heading}\n\n${card.purpose}${also}`,
    situations.join('\n'),
    card.practice.map((p) => `- ${p}`).join('\n'),
    card.example
      ? `Example:\n\n\`\`\`json\n${JSON.stringify(card.example, null, 2)}\n\`\`\``
      : null,
    card.redFlag ? `Red flag: ${card.redFlag}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join('\n\n');
}

/**
 * The module lines of a Tier-0 map (ISS-1256): one line per business module, as `moduleMapLines`
 * ranks them, naming the door that reads its tree (Tier 1) — the REST read for a master and its runs,
 * which work over REST, `module.get` for every other audience — as many whole lines as
 * `TIER0_MODULE_LINES_MAX_CHARS` holds. Empty where the project has no module yet.
 */
export function moduleLinesText(lines: readonly ModuleMapLine[], audience: CardAudience): string {
  if (lines.length === 0) return '';
  const door = (slug: string) =>
    audience === 'master' || audience === 'run'
      ? `GET /api/projects/:id/modules/${slug}/map`
      : `module.get ${slug}`;
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    const purpose = l.description ? `: ${l.description.split('\n')[0]?.slice(0, 90)}` : '';
    const line = `- ${l.name} (\`${l.slug}\`)${purpose}; ${l.terms} terms, ${l.rules} rules, ${l.openIssues} open → ${door(l.slug)}`;
    if (size + line.length + 1 > TIER0_MODULE_LINES_MAX_CHARS) continue;
    size += line.length + 1;
    out.push(line);
  }
  return `### Modules\nBefore you work in a module, read its tree (its terms, rules, capabilities and requirements); when a person names a thing or an owner decides, write the term or rule under its module.\n${out.join('\n')}`;
}
