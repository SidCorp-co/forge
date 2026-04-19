import { Bot } from 'grammy';
import type { ChannelPlugin, ChannelConfig, SendOptions } from '../types';
import type { NormalizedMessage } from '../message';
import { createTelegramBot, setupMessageHandler } from './bot';
import { sendTelegramReply } from './outbound';

export class TelegramPlugin implements ChannelPlugin {
  id = 'telegram';
  capabilities = {
    threads: false,
    reactions: false,
    media: true,
    maxChunkSize: 4000,
  };

  private bot: Bot | null = null;

  async start(
    config: ChannelConfig,
    onMessage: (msg: NormalizedMessage) => void,
  ): Promise<void> {
    const token = config.token as string;
    const allowFrom = (config.allowFrom as string[]) ?? [];
    const dmPolicy = (config.dmPolicy as string) ?? 'allowlist';

    this.bot = createTelegramBot(token);
    setupMessageHandler(this.bot, allowFrom, dmPolicy, onMessage);
    this.bot.catch((err: unknown) => console.error('[telegram-plugin] Bot error', err));
    this.bot.start({ onStart: () => console.log('[telegram-plugin] Polling started') })
      .catch((err: unknown) => console.error('[telegram-plugin] Bot polling failed', err));
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  async send(to: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    await sendTelegramReply(this.bot, to, text, this.capabilities.maxChunkSize);
  }

  async sendTyping(to: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not started');
    await this.bot.api.sendChatAction(to, 'typing');
  }
}
