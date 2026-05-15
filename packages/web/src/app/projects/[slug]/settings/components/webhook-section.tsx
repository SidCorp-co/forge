'use client';

import { Switch, Input, Label } from '@/components/ui';
import { ALL_STATUSES } from '@/lib/constants';

interface WebhookSectionProps {
  webhookUrl?: string;
  setWebhookUrl?: (v: string) => void;
  webhookSecret?: string;
  setWebhookSecret?: (v: string) => void;
  webhookStatuses?: string[];
  setWebhookStatuses?: (v: string[] | ((prev: string[]) => string[])) => void;
  previewMode?: boolean;
}

export function WebhookSection({
  webhookUrl = '',
  setWebhookUrl,
  webhookSecret = '',
  setWebhookSecret,
  webhookStatuses = [],
  setWebhookStatuses,
  previewMode = false,
}: WebhookSectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Generic Webhooks</h2>
        <span className="text-[9px] font-mono text-outline">INT_WHK</span>
      </div>
      {previewMode && (
        <div className="rounded-sm border border-warning/30 bg-warning-dim/10 p-3 text-[10px] font-bold uppercase tracking-widest text-warning">
          Coming v0.1.x — preview only
        </div>
      )}
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
      <p className="text-[10px] text-outline">
        Send an HTTP POST to a URL when issue status changes.
      </p>
      <div className="space-y-4">
        <div>
          <Label>Webhook URL</Label>
          <Input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl?.(e.target.value)}
            placeholder="https://hooks.example.com/notify"
            disabled={previewMode}
          />
        </div>
        <div>
          <Label hint="(optional)">Secret / Token</Label>
          <Input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret?.(e.target.value)}
            placeholder="e.g. Bearer mytoken or ApiKey xyz"
            disabled={previewMode}
          />
        </div>
        <div>
          <Label>Trigger on statuses</Label>
          <p className="mb-2 text-[10px] text-outline">Leave all unchecked to trigger on every status change.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {ALL_STATUSES.map((s) => (
              <Switch
                key={s.value}
                id={`webhook-status-${s.value}`}
                checked={webhookStatuses.includes(s.value)}
                onChange={(e) => {
                  setWebhookStatuses?.((prev) =>
                    e.target.checked
                      ? [...prev, s.value]
                      : prev.filter((v) => v !== s.value),
                  );
                }}
                label={s.label}
                disabled={previewMode}
              />
            ))}
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}
