'use client';

import { Button, Input, Label, Switch } from '@/components/ui';
import type { ChannelConfig } from '@/features/project/types';

const CHANNEL_TYPES = [
  { value: 'rocketchat', label: 'Rocket.Chat' },
  { value: 'telegram', label: 'Telegram' },
] as const;

const CONFIG_FIELDS: Record<string, { key: string; label: string; placeholder: string; type?: string }[]> = {
  rocketchat: [
    { key: 'serverUrl', label: 'Server URL', placeholder: 'https://chat.example.com' },
    { key: 'username', label: 'Bot Username', placeholder: 'forge_bot' },
    { key: 'password', label: 'Bot Password', placeholder: 'password', type: 'password' },
    { key: 'listenChannels', label: 'Listen Channels', placeholder: 'general, forge (comma-separated, @mention only)' },
    { key: 'dmPolicy', label: 'DM Policy', placeholder: 'open | allowlist' },
    { key: 'allowFrom', label: 'Allow From (user IDs)', placeholder: 'userId1, userId2' },
  ],
  telegram: [
    { key: 'token', label: 'Bot Token', placeholder: 'BOT_TOKEN from @BotFather', type: 'password' },
    { key: 'dmPolicy', label: 'DM Policy', placeholder: 'open | allowlist | pairing' },
    { key: 'allowFrom', label: 'Allow From (user IDs)', placeholder: 'userId1, userId2' },
  ],
};

interface ChannelsSectionProps {
  channels?: ChannelConfig[];
  updateChannel?: (index: number, channel: Partial<ChannelConfig>) => void;
  updateChannelConfig?: (index: number, key: string, value: string) => void;
  removeChannel?: (index: number) => void;
  addChannel?: () => void;
  previewMode?: boolean;
}

const PREVIEW_CHANNELS: ChannelConfig[] = [
  { type: 'rocketchat', name: 'Team chat', enabled: false, config: {} },
];

export function ChannelsSection({
  channels,
  updateChannel,
  updateChannelConfig,
  removeChannel,
  addChannel,
  previewMode = false,
}: ChannelsSectionProps) {
  const rows = channels ?? (previewMode ? PREVIEW_CHANNELS : []);

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Channels</h2>
        <span className="text-[9px] font-mono text-outline">INT_CHN</span>
      </div>
      {previewMode && (
        <div className="rounded-sm border border-warning/30 bg-warning-dim/10 p-3 text-[10px] font-bold uppercase tracking-widest text-warning">
          Coming v0.1.x — preview only
        </div>
      )}
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <p className="text-[10px] text-outline">
          Connect messaging platforms so users can chat with the AI agent via DM or @mention.
        </p>
        <div className="space-y-6">
          {rows.map((ch, i) => (
            <div key={i} className="border border-outline-variant/20 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <select
                    value={ch.type}
                    onChange={(e) =>
                      updateChannel?.(i, { type: e.target.value as ChannelConfig['type'], config: {} })
                    }
                    disabled={previewMode}
                    className="bg-surface-container border border-outline-variant/30 text-on-surface text-[11px] px-2 py-1.5 font-mono disabled:opacity-50"
                  >
                    {CHANNEL_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <Input
                    type="text"
                    value={ch.name}
                    onChange={(e) => updateChannel?.(i, { name: e.target.value })}
                    placeholder="Display name"
                    className="w-48"
                    disabled={previewMode}
                  />
                  <Switch
                    id={`channel-enabled-${i}`}
                    checked={ch.enabled}
                    onChange={(e) => updateChannel?.(i, { enabled: e.target.checked })}
                    label="Enabled"
                    disabled={previewMode}
                  />
                </div>
                {!previewMode && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => removeChannel?.(i)}
                    className="text-danger hover:bg-danger-surface"
                  >
                    Remove
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                {(CONFIG_FIELDS[ch.type] ?? []).map((field) => (
                  <div key={field.key}>
                    <Label>{field.label}</Label>
                    <Input
                      type={field.type ?? 'text'}
                      value={ch.config[field.key] ?? ''}
                      onChange={(e) => updateChannelConfig?.(i, field.key, e.target.value)}
                      placeholder={field.placeholder}
                      disabled={previewMode}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {!previewMode && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => addChannel?.()}
              className="border-dashed"
            >
              + Add Channel
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
