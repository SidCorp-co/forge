'use client';

import { useState } from 'react';
import { Input, Label } from '@/components/ui';
import { Check, Copy, RefreshCw, Plus, Trash2 } from 'lucide-react';

const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api').replace(/\/api\/?$/, '');

interface GitlabWebhookSectionProps {
  gitRepoUrl: string;
  setGitRepoUrl: (v: string) => void;
  webhookSecret: string;
  setWebhookSecret: (v: string) => void;
  useRegistry: boolean;
  setUseRegistry: (v: boolean) => void;
  previewEnvVars: { key: string; value: string }[];
  setPreviewEnvVars: (v: { key: string; value: string }[]) => void;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function GitlabWebhookSection({ gitRepoUrl, setGitRepoUrl, webhookSecret, setWebhookSecret, useRegistry, setUseRegistry, previewEnvVars, setPreviewEnvVars }: GitlabWebhookSectionProps) {
  const webhookUrl = `${API_ORIGIN}/api/preview-deploy/webhook`;
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);

  const copy = (text: string, key: 'url' | 'secret') => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleGenerate = () => {
    const token = generateToken();
    setWebhookSecret(token);
    copy(token, 'secret');
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">09. GitLab Webhook</h2>
        <span className="text-[9px] font-mono text-outline">GLB_EXT_09</span>
      </div>
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
      <p className="text-[10px] text-outline">
        Add this URL as a webhook in your GitLab repo (Settings → Webhooks) to auto-deploy
        preview environments when branches matching <code className="rounded bg-surface-container-high px-1">ISS-{'<id>'}-*</code> are pushed.
      </p>
      <div className="space-y-4">
        <div>
          <Label>Git Repository URL</Label>
          <Input
            value={gitRepoUrl}
            onChange={(e) => setGitRepoUrl(e.target.value)}
            placeholder="git@gitlab.com:org/repo.git"
          />
          <p className="mt-1 text-[10px] text-outline">
            SSH or HTTPS URL. Must match the repo URL in GitLab push events.
          </p>
        </div>
        <div>
          <Label>Webhook URL</Label>
          <div className="flex items-center gap-2">
            <Input
              value={webhookUrl}
              readOnly
              className="flex-1 bg-surface-container-low font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => copy(webhookUrl, 'url')}
              className="rounded border border-outline-variant/30 p-2 text-outline hover:text-on-surface-variant"
              title="Copy URL"
            >
              {copied === 'url' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-outline">
            Trigger: Push events. Enable SSL verification.
          </p>
        </div>
        <div>
          <Label hint="(per-project, must match X-Gitlab-Token)">Secret Token</Label>
          <div className="flex items-center gap-2">
            <Input
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              className="flex-1 font-mono text-xs"
              placeholder="Click Generate to create a token"
            />
            <button
              type="button"
              onClick={handleGenerate}
              className="flex items-center gap-1 rounded border border-outline-variant/30 px-2 py-1.5 text-xs text-primary-fixed hover:text-on-surface-variant"
              title="Generate and copy new token"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Generate
            </button>
            {webhookSecret && (
              <button
                type="button"
                onClick={() => copy(webhookSecret, 'secret')}
                className="rounded border border-outline-variant/30 p-2 text-outline hover:text-on-surface-variant"
                title="Copy token"
              >
                {copied === 'secret' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            )}
          </div>
          <p className="mt-1 text-[10px] text-outline">
            Paste this token in GitLab webhook &quot;Secret token&quot; field. Each project uses its own token.
          </p>
        </div>
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={useRegistry}
                onChange={(e) => setUseRegistry(e.target.checked)}
                className="peer sr-only"
              />
              <span className="block h-5 w-9 rounded-none bg-surface-container-highest border border-outline-variant/30 peer-checked:bg-primary-fixed transition-colors" />
              <span className="absolute left-[3px] top-[3px] h-3.5 w-3.5 bg-outline peer-checked:bg-primary peer-checked:translate-x-[14px] transition-all" />
            </span>
            <span className="text-sm text-on-surface-variant">Use Container Registry</span>
          </label>
          <p className="mt-1 ml-6 text-[10px] text-outline">
            GitLab CI builds and pushes images to registry. Deploys pull pre-built images instead of building on server.
          </p>
        </div>
        <div>
          <Label hint="(passed to docker compose at build/run time)">Environment Variables</Label>
          <div className="space-y-2">
            {previewEnvVars.map((env, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={env.key}
                  onChange={(e) => {
                    const next = [...previewEnvVars];
                    next[i] = { ...next[i], key: e.target.value };
                    setPreviewEnvVars(next);
                  }}
                  placeholder="KEY"
                  className="w-1/3 font-mono text-xs"
                />
                <Input
                  value={env.value}
                  onChange={(e) => {
                    const next = [...previewEnvVars];
                    next[i] = { ...next[i], value: e.target.value };
                    setPreviewEnvVars(next);
                  }}
                  placeholder="value"
                  className="flex-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setPreviewEnvVars(previewEnvVars.filter((_, j) => j !== i))}
                  className="rounded p-1.5 text-outline hover:bg-danger-surface hover:text-danger"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setPreviewEnvVars([...previewEnvVars, { key: '', value: '' }])}
              className="flex items-center gap-1 text-xs text-primary-fixed hover:text-on-surface-variant"
            >
              <Plus className="h-3.5 w-3.5" />
              Add variable
            </button>
          </div>
          <p className="mt-1 text-[10px] text-outline">
            e.g. DATABASE_URL, NEXT_PUBLIC_API_URL. Forge auto-creates a per-issue database if DATABASE_URL is set.
          </p>
        </div>
      </div>
      </div>
    </section>
  );
}
