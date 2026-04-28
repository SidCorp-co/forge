'use client';

import { Input, Label } from '@/components/ui';

interface SentrySectionProps {
  sentryProject: string;
  setSentryProject: (v: string) => void;
}

export function SentrySection({ sentryProject, setSentryProject }: SentrySectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">08. Sentry</h2>
        <span className="text-[9px] font-mono text-outline">SNT_EXT_08</span>
      </div>
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Sentry Project Slug</Label>
          <Input
            type="text"
            value={sentryProject}
            onChange={(e) => setSentryProject(e.target.value)}
            placeholder="e.g. teamix-nextjs (leave empty for all projects)"
          />
          <p className="mt-1 text-[10px] text-outline">
            Scope Sentry error queries to this project. Leave empty to search all projects in the org.
          </p>
        </div>
      </div>
    </section>
  );
}
