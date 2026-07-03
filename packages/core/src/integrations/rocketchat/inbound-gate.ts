/**
 * ISS-604 (P2d) — pure inbound-message gate for the Rocket.Chat bot.
 *
 * Kept dependency-free (type-only import) so it's unit-testable without booting
 * env/db. Decides whether an incoming room message should trigger a bot reply:
 * skip the bot's own messages (loop guard), system/edit events, empty text, and
 * anything that doesn't @-mention the bot (trigger-gating for noise + cost).
 */

import type { RocketChatIncomingMessage } from './ddp-client.js';

export function decideHandling(
  msg: RocketChatIncomingMessage,
  botUserId: string,
): { handle: boolean; reason: string } {
  if (msg.userId === botUserId) return { handle: false, reason: 'own-message' };
  if (msg.isSystem) return { handle: false, reason: 'system' };
  if (msg.isEdited) return { handle: false, reason: 'edited' };
  if (!msg.text.trim()) return { handle: false, reason: 'empty' };
  if (!msg.mentions.includes(botUserId)) return { handle: false, reason: 'not-mentioned' };
  return { handle: true, reason: 'ok' };
}
