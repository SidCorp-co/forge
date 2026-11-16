// Each MCP action's capability card (ISS-1251), declared beside the door on its tool
// (`McpTool.cards`) and attached to the action's catalog entry, so `forge_find` matches an agent's
// situation and `forge_describe` answers the card with the action's input. A card for an action the
// tool does not take, or one that does not stand, is refused by name when the registry is built.

import { type CapabilityCard, capabilityCardSchema } from '@forge/contracts/capability-cards';
import { type CardFreshness, cardFreshness } from '../lessons/index.js';
import type { McpTool } from '../lib/tool.js';
import { AFFORDANCE_CARDS } from '../prompt/index.js';
import { REST_TWINS } from './twins.js';

/** The feature an action belongs to: its tool, and the REST twin the tool names. */
export const featureOf = (tool: Pick<McpTool, 'name' | 'route'>) =>
  tool.route ? `${tool.name} (${[tool.route].flat().join(', ')})` : tool.name;

/** The cards `tool` declares, by action, each judged whole against the card schema. */
export function cardsOf(tool: McpTool, actions: readonly string[]): Map<string, CapabilityCard> {
  const cards = new Map<string, CapabilityCard>();
  if (tool.cards && !tool.source) {
    throw new Error(
      `mcp registry: ${tool.name} declares cards and names no source (source: sourceOf(import.meta.url)), so a landing touching its door cannot owe them a re-check (mcp/cards.ts)`,
    );
  }
  for (const [action, body] of Object.entries(tool.cards ?? {})) {
    if (!actions.includes(action)) {
      throw new Error(
        `mcp registry: ${tool.name} declares a card for ${action}, which it does not take (mcp/cards.ts)`,
      );
    }
    const parsed = capabilityCardSchema.safeParse(body);
    if (!parsed.success) {
      const said = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`mcp registry: ${tool.name}'s card for ${action} does not stand: ${said}`);
    }
    const id = `${tool.name.replace(/^forge_/, '')}.${action}`;
    cards.set(action, { id, owner: featureOf(tool), ...parsed.data });
  }
  // an act whose one card sits on its REST twin, the orientation's (`twins.ts`)
  for (const action of actions) {
    const twins = REST_TWINS[`${tool.name.replace(/^forge_/, '')}.${action}`] ?? [];
    const twin = AFFORDANCE_CARDS.find((c) => twins.includes(c.id));
    if (twin && !cards.has(action)) cards.set(action, twin);
  }
  return cards;
}

/** The entry with its card, the card's example judged against the action's input by name. */
export function withCard<E extends { id: string; input: Record<string, unknown> }>(
  entry: E,
  card: CapabilityCard | undefined,
): E & { card?: CapabilityCard } {
  if (!card) return entry;
  const properties = (entry.input.properties as Record<string, unknown> | undefined) ?? {};
  for (const name of Object.keys(card.example ?? {})) {
    if (name !== 'action' && !(name in properties)) {
      throw new Error(
        `mcp registry: the card for ${entry.id} has an example naming \`${name}\`, which its input does not take (mcp/cards.ts)`,
      );
    }
  }
  return { ...entry, card };
}

/** The words a card's situations add to an action's match, so an agent finds it by what it is doing. */
export const situationText = (card: CapabilityCard | undefined) =>
  card ? card.situations.map((s) => `${s.when} ${s.do}`).join(' ') : '';

type Proposed = CardFreshness['proposedDeltas'][number];

/**
 * The card as `forge_describe` answers it: what to do when, how to do it well, and what goes wrong.
 * Where describe already answers the action's own example (`exampleShown`), the card's is left out:
 * one example to call by, not two.
 */
export const describedCard = (
  card: CapabilityCard,
  proposed: readonly Proposed[] = [],
  exampleShown = false,
) => ({
  purpose: card.purpose,
  when: card.situations.map((s) => `${s.when} → ${s.do}${s.watch ? ` (watch: ${s.watch})` : ''}`),
  practice: card.practice,
  ...(card.example && !exampleShown ? { cardExample: card.example } : {}),
  ...(card.redFlag ? { redFlag: card.redFlag } : {}),
  // a lesson folded into the card stays taught here until its code carries it (owner of ISS-1251's
  // fold: the orchestrator, 2026-11-16), marked as proposed so it is not read as the card's own text
  ...(proposed.length > 0
    ? {
        proposed: proposed.map((d) => ({
          field: d.field,
          op: d.op,
          text: d.text,
          ...(d.replaces ? { replaces: d.replaces } : {}),
          from: d.fromLesson,
        })),
        proposedNote: 'learned from use and not yet in the card itself: weigh it as a lesson',
      }
    : {}),
});

/** The deltas proposed for a card that reach a project: its own and those for every project. */
export async function proposedFor(cardId: string, projectId: string | null): Promise<Proposed[]> {
  const [fresh] = await cardFreshness([cardId]);
  return (fresh?.proposedDeltas ?? []).filter(
    (d) => d.projectId === null || d.projectId === projectId,
  );
}
