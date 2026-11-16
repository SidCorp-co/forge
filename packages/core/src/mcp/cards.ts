// Each MCP action's capability card (ISS-1251), declared beside the door on its tool
// (`McpTool.cards`) and attached to the action's catalog entry, so `forge_find` matches an agent's
// situation and `forge_describe` answers the card with the action's input. A card for an action the
// tool does not take, or one that does not stand, is refused by name when the registry is built.

import { type CapabilityCard, capabilityCardSchema } from '@forge/contracts/capability-cards';
import type { McpTool } from '../lib/tool.js';

/** The feature an action belongs to: its tool, and the REST twin the tool names. */
export const featureOf = (tool: Pick<McpTool, 'name' | 'route'>) =>
  tool.route ? `${tool.name} (${[tool.route].flat().join(', ')})` : tool.name;

/** The cards `tool` declares, by action, each judged whole against the card schema. */
export function cardsOf(tool: McpTool, actions: readonly string[]): Map<string, CapabilityCard> {
  const cards = new Map<string, CapabilityCard>();
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

/** The card as `forge_describe` answers it: what to do when, how to do it well, and what goes wrong. */
export const describedCard = (card: CapabilityCard) => ({
  purpose: card.purpose,
  when: card.situations.map((s) => `${s.when} → ${s.do}${s.watch ? ` (watch: ${s.watch})` : ''}`),
  practice: card.practice,
  ...(card.example ? { cardExample: card.example } : {}),
  ...(card.redFlag ? { redFlag: card.redFlag } : {}),
});
