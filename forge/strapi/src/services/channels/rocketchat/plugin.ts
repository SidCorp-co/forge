import type { ChannelPlugin, ChannelConfig, SendOptions } from '../types';
import type { NormalizedMessage } from '../message';
import { chunkText } from '../chunker';
import { markdownToRocketChat } from './format';
import {
  login,
  sendMessage,
  sendTypingIndicator,
  getDirectMessageHistory,
  listDirectMessages,
  listJoinedChannels,
  getChannelHistory,
  type RocketChatAuth,
} from './api';

export class RocketChatPlugin implements ChannelPlugin {
  id = 'rocketchat';
  capabilities = {
    threads: true,
    reactions: true,
    media: true,
    maxChunkSize: 4000,
  };

  private auth: RocketChatAuth | null = null;
  private serverUrl = '';
  private botUsername = '';
  private listenChannels: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTimestamp = new Date().toISOString();

  async start(
    config: ChannelConfig,
    onMessage: (msg: NormalizedMessage) => void,
  ): Promise<void> {
    this.serverUrl = (config.serverUrl as string).replace(/\/+$/, '');
    const username = config.username as string;
    const password = config.password as string;
    const allowFrom = (config.allowFrom as string[]) ?? [];
    const dmPolicy = (config.dmPolicy as string) ?? 'open';
    this.listenChannels = (config.listenChannels as string[]) ?? [];

    this.auth = await login(this.serverUrl, username, password);
    this.botUsername = username;
    this.lastTimestamp = new Date().toISOString();

    console.log(`[rocketchat-plugin] Started: DM polling + ${this.listenChannels.length} channel(s): [${this.listenChannels.join(', ')}]`);

    // Poll for new DMs and channel @mentions every 5 seconds (RC rate limit is 3s per endpoint)
    this.pollTimer = setInterval(async () => {
      try {
        await this.pollDirectMessages(allowFrom, dmPolicy, onMessage);
        if (this.listenChannels.length > 0) {
          await this.pollChannelMentions(onMessage);
        }
        this.lastTimestamp = new Date().toISOString();
      } catch (err) {
        console.error('[rocketchat-plugin] Poll error:', err);
      }
    }, 5000);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.auth = null;
  }

  async send(to: string, text: string, opts?: SendOptions): Promise<void> {
    if (!this.auth) throw new Error('Rocket.Chat not connected');
    const formatted = markdownToRocketChat(text);
    const chunks = chunkText(formatted, this.capabilities.maxChunkSize);
    for (const chunk of chunks) {
      await sendMessage(
        this.serverUrl,
        this.auth,
        to,
        chunk,
        opts?.replyTo,
      );
    }
  }

  async sendTyping(to: string): Promise<void> {
    if (!this.auth) throw new Error('Rocket.Chat not connected');
    await sendTypingIndicator(this.serverUrl, this.auth, to, this.botUsername);
  }

  private async pollDirectMessages(
    allowFrom: string[],
    dmPolicy: string,
    onMessage: (msg: NormalizedMessage) => void,
  ): Promise<void> {
    if (!this.auth) return;

    const dms = await listDirectMessages(this.serverUrl, this.auth);

    for (const dm of dms) {
      const roomId = dm._id as string;

      const lastMsg = dm.lastMessage;
      if (!lastMsg) continue;
      const lastMsgTs = new Date(lastMsg.ts).toISOString();
      if (lastMsgTs <= this.lastTimestamp) continue;
      if (lastMsg.u?._id === this.auth.userId) continue;

      const messages = await getDirectMessageHistory(
        this.serverUrl,
        this.auth,
        roomId,
        this.lastTimestamp,
      );

      const incoming = messages
        .filter((m: any) => m.u._id !== this.auth!.userId)
        .sort((a: any, b: any) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

      for (const m of incoming) {
        const fromUsername = m.u.username || m.u._id;
        if (dmPolicy === 'allowlist' && !allowFrom.includes(m.u._id) && !allowFrom.includes(fromUsername)) continue;

        onMessage({
          id: m._id,
          channel: 'rocketchat',
          from: fromUsername,
          to: roomId,
          text: m.msg,
          threadId: m.tmid,
          timestamp: new Date(m.ts).getTime(),
          raw: m,
        });
      }
    }
  }

  private async pollChannelMentions(
    onMessage: (msg: NormalizedMessage) => void,
  ): Promise<void> {
    if (!this.auth) return;

    const allChannels = await listJoinedChannels(this.serverUrl, this.auth);

    // Filter to configured listen channels (by name)
    const channels = this.listenChannels.length > 0
      ? allChannels.filter((c: any) => this.listenChannels.includes(c.name))
      : allChannels;

    for (const ch of channels) {
      const roomId = ch._id as string;

      const lastMsg = ch.lastMessage;
      if (!lastMsg) continue;
      const lastMsgTs = new Date(lastMsg.ts).toISOString();
      if (lastMsgTs <= this.lastTimestamp) continue;

      const messages = await getChannelHistory(
        this.serverUrl,
        this.auth,
        roomId,
        this.lastTimestamp,
      );

      const incoming = messages
        .filter((m: any) => {
          if (m.u._id === this.auth!.userId) return false;
          // Only respond to messages that @mention the bot
          const mentionsBot = (m.mentions ?? []).some(
            (mention: any) => mention.username === this.botUsername,
          );
          return mentionsBot;
        })
        .sort((a: any, b: any) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

      const channelName = ch.name as string;

      for (const m of incoming) {
        // Strip the @bot mention from the message text
        const text = m.msg
          .replace(new RegExp(`@${this.botUsername}\\b`, 'g'), '')
          .trim();

        if (!text) continue;

        const fromUsername = m.u.username || m.u._id;

        onMessage({
          id: m._id,
          channel: `rocketchat:${channelName}`,
          from: fromUsername,
          to: roomId,
          text,
          threadId: m.tmid,
          timestamp: new Date(m.ts).getTime(),
          raw: m,
        });
      }
    }
  }
}
