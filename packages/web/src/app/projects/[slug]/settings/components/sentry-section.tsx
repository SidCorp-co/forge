'use client';

import { Input, Label } from '@/components/ui';

interface SentrySectionProps {
  sentryProject?: string;
  setSentryProject?: (v: string) => void;
  previewMode?: boolean;
}

export function SentrySection({
  sentryProject = '',
  setSentryProject,
  previewMode = false,
}: SentrySectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Sentry</h2>
        <span className="text-[9px] font-mono text-outline">INT_SNT</span>
      </div>
      {previewMode && (
        <div className="rounded-sm border border-warning/30 bg-warning-dim/10 p-3 text-[10px] font-bold uppercase tracking-widest text-warning">
          Coming v0.1.x — preview only
        </div>
      )}
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Sentry Project Slug</Label>
          <Input
            type="text"
            value={sentryProject}
            onChange={(e) => setSentryProject?.(e.target.value)}
            placeholder="e.g. teamix-nextjs (leave empty for all projects)"
            disabled={previewMode}
          />
          <p className="mt-1 text-[10px] text-outline">
            Scope Sentry error queries to this project. Leave empty to search all projects in the org.
          </p>
        </div>
      </div>
    </section>
  );
}
