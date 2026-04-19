import { Bot } from 'grammy';
import type { NormalizedMessage } from '../message';

// Pairing store: userId -> { code, expiresAt }
const pendingPairings = new Map<string, { code: string; expiresAt: number }>();
const approvedUsers = new Set<string>();

function generatePairingCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function approvePairing(userId: string): boolean {
  if (pendingPairings.has(userId)) {
    pendingPairings.delete(userId);
    approvedUsers.add(userId);
    console.log(`[telegram-bot] Pairing approved for user ${userId}`);
    return true;
  }
  return false;
}

export function getPendingPairings(): Array<{ userId: string; code: string }> {
  const result: Array<{ userId: string; code: string }> = [];
  for (const [userId, { code, expiresAt }] of pendingPairings) {
    if (Date.now() < expiresAt) {
      result.push({ userId, code });
    }
  }
  return result;
}

export function createTelegramBot(token: string): Bot {
  return new Bot(token);
}

export function setupMessageHandler(
  bot: Bot,
  allowFrom: string[],
  dmPolicy: string,
  onMessage: (msg: NormalizedMessage) => void,
): void {
  // Pre-load allowFrom into approved set
  for (const id of allowFrom) {
    approvedUsers.add(id);
  }

  bot.on('message:text', async (ctx) => {
    const fromId = String(ctx.from.id);
    const displayName = ctx.from.first_name ?? 'Unknown';
    console.log(`[telegram-bot] Message from ${displayName} (${fromId}): ${ctx.message.text.slice(0, 100)}`);

    // --- Access control ---

    if (dmPolicy === 'open') {
      // Allow everyone
    } else if (dmPolicy === 'allowlist') {
      if (!approvedUsers.has(fromId) && !allowFrom.includes(fromId)) {
        return;
      }
    } else if (dmPolicy === 'pairing') {
      if (!approvedUsers.has(fromId) && !allowFrom.includes(fromId)) {
        const existing = pendingPairings.get(fromId);
        if (existing && Date.now() < existing.expiresAt) {
          await ctx.reply(
            `Pairing pending. Your code: <b>${existing.code}</b>\nWaiting for approval.`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        const code = generatePairingCode();
        pendingPairings.set(fromId, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
        console.log(`[telegram-bot] Pairing request from ${displayName} (${fromId}): ${code}`);

        await ctx.reply(
          `Hi ${displayName}! I don't recognize you yet.\n\nYour pairing code: <b>${code}</b>\n\nAsk the owner to approve with: <code>/pair ${fromId}</code>`,
          { parse_mode: 'HTML' },
        );
        return;
      }
    }

    // --- Handle /pair command (owner only) ---
    if (ctx.message.text.startsWith('/pair ') && allowFrom.includes(fromId)) {
      const targetId = ctx.message.text.split(' ')[1]?.trim();
      if (targetId && approvePairing(targetId)) {
        await ctx.reply(`User ${targetId} approved.`);
        // Notify the paired user
        try {
          await bot.api.sendMessage(targetId, "You've been approved! You can now chat with me.");
        } catch { /* user may have blocked bot */ }
      } else {
        await ctx.reply(`No pending pairing for ${targetId}.`);
      }
      return;
    }

    // --- Handle /unpair command (owner only) ---
    if (ctx.message.text.startsWith('/unpair ') && allowFrom.includes(fromId)) {
      const targetId = ctx.message.text.split(' ')[1]?.trim();
      if (targetId) {
        approvedUsers.delete(targetId);
        await ctx.reply(`User ${targetId} removed.`);
      }
      return;
    }

    // --- Handle /pairings command (owner only) ---
    if (ctx.message.text === '/pairings' && allowFrom.includes(fromId)) {
      const pending = getPendingPairings();
      if (pending.length === 0) {
        await ctx.reply('No pending pairings.');
      } else {
        const lines = pending.map((p) => `• ${p.userId} — code: ${p.code}`);
        await ctx.reply(`Pending pairings:\n${lines.join('\n')}`);
      }
      return;
    }

    // --- Normalize and forward ---
    const msg: NormalizedMessage = {
      id: String(ctx.message.message_id),
      channel: 'telegram',
      from: fromId,
      to: String(ctx.chat.id),
      text: ctx.message.text,
      replyTo: ctx.message.reply_to_message
        ? String(ctx.message.reply_to_message.message_id)
        : undefined,
      timestamp: ctx.message.date * 1000,
      raw: ctx.message,
    };

    onMessage(msg);
  });
}
