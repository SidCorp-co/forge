import type { Core } from '@strapi/strapi';
import { ChannelRegistry } from './registry';
import { MessageDebouncer } from './debounce';
import { handleChannelMessage } from './handler';

interface ChannelEntry {
  type: 'rocketchat' | 'telegram';
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

/**
 * Load channel configs from all projects and start plugins.
 * Falls back to env vars for backward compatibility.
 */
export async function bootstrapChannels(strapi: Core.Strapi): Promise<void> {
  const registry = new ChannelRegistry();

  // 1. Load from DB — projects with non-empty channels array
  const projects = await strapi.documents('api::project.project').findMany({
    filters: {},
    populate: [],
  });

  for (const project of projects) {
    const channels = (project as any).channels as ChannelEntry[] | null;
    if (!channels?.length) continue;

    for (const ch of channels) {
      if (!ch.enabled) continue;

      // Find app-config for this project to get the appId
      const appConfigs = await strapi.documents('api::app-config.app-config').findMany({
        filters: { project: { documentId: { $eq: project.documentId } } },
        populate: ['project'],
        limit: 1,
      });
      const appId = appConfigs?.[0]?.appId ?? 'default';

      try {
        await startChannel(strapi, registry, ch, appId, project.name);
      } catch (err: any) {
        strapi.log.error(`[channels] Failed to start ${ch.type}/${ch.name} for ${project.name}: ${err.message}`);
      }
    }
  }

  // 2. Env var fallback — Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const hasDbTelegram = registry.get('telegram');
    if (!hasDbTelegram) {
      await startChannel(strapi, registry, {
        type: 'telegram',
        name: 'telegram-env',
        enabled: true,
        config: {
          token: process.env.TELEGRAM_BOT_TOKEN,
          allowFrom: process.env.TELEGRAM_ALLOW_FROM || '',
          dmPolicy: process.env.TELEGRAM_DM_POLICY || 'open',
        },
      }, process.env.TELEGRAM_APP_ID || 'default', 'env');
    }
  }

  // 3. Env var fallback — Rocket.Chat
  if (process.env.ROCKETCHAT_URL) {
    const hasDbRocketchat = registry.get('rocketchat');
    if (!hasDbRocketchat) {
      await startChannel(strapi, registry, {
        type: 'rocketchat',
        name: 'rocketchat-env',
        enabled: true,
        config: {
          serverUrl: process.env.ROCKETCHAT_URL,
          username: process.env.ROCKETCHAT_USERNAME || '',
          password: process.env.ROCKETCHAT_PASSWORD || '',
          allowFrom: process.env.ROCKETCHAT_ALLOW_FROM || '',
          dmPolicy: process.env.ROCKETCHAT_DM_POLICY || 'open',
        },
      }, process.env.ROCKETCHAT_APP_ID || 'default', 'env');
    }
  }
}

async function startChannel(
  strapi: Core.Strapi,
  registry: ChannelRegistry,
  ch: ChannelEntry,
  appId: string,
  source: string,
): Promise<void> {
  if (ch.type === 'rocketchat') {
    const { RocketChatPlugin } = require('./rocketchat/plugin');
    const plugin = new RocketChatPlugin();
    registry.register(plugin);

    const debouncer = new MessageDebouncer(1500, async (_sessionKey: string, messages: any[]) => {
      const combined = messages.map((m: any) => m.text).join('\n');
      const msg = { ...messages[0], text: combined };
      await handleChannelMessage(strapi, msg, appId, async (text: string) => {
        await plugin.send(msg.to, text);
      });
    });

    const allowFrom = (ch.config.allowFrom || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const listenChannels = (ch.config.listenChannels || '').split(',').map((s: string) => s.trim()).filter(Boolean);

    await plugin.start(
      {
        serverUrl: ch.config.serverUrl,
        username: ch.config.username,
        password: ch.config.password,
        allowFrom,
        dmPolicy: ch.config.dmPolicy || 'open',
        listenChannels,
      },
      (msg: any) => debouncer.push(`channel:rocketchat:${msg.from}`, msg),
    );
    strapi.log.info(`[channels] Rocket.Chat "${ch.name}" started (${source})`);

  } else if (ch.type === 'telegram') {
    const { TelegramPlugin } = require('./telegram/plugin');
    const plugin = new TelegramPlugin();
    registry.register(plugin);

    const debouncer = new MessageDebouncer(1500, async (_sessionKey: string, messages: any[]) => {
      const combined = messages.map((m: any) => m.text).join('\n');
      const msg = { ...messages[0], text: combined };
      await handleChannelMessage(strapi, msg, appId, async (text: string) => {
        await plugin.send(msg.to, text);
      });
    });

    const allowFrom = (ch.config.allowFrom || '').split(',').map((s: string) => s.trim()).filter(Boolean);

    await plugin.start(
      {
        token: ch.config.token,
        allowFrom,
        dmPolicy: ch.config.dmPolicy || 'open',
      },
      (msg: any) => debouncer.push(`channel:telegram:${msg.from}`, msg),
    );
    strapi.log.info(`[channels] Telegram "${ch.name}" started (${source})`);
  }
}
