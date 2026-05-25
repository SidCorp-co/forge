'use client';

import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, subtitle, right, children }: PanelProps) {
  return (
    <section className="rounded-sm border border-outline-variant/30 bg-surface-container-low">
      <header className="flex items-center justify-between border-b border-outline-variant/20 px-4 py-3">
        <div>
          <h2 className="text-[10px] uppercase tracking-[0.15em] font-bold text-on-surface-variant">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-[10px] text-outline">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function LoadingLine() {
  return <p className="py-8 text-center text-xs text-outline">Loading…</p>;
}

export function ErrorPill({ message }: { message: string }) {
  return (
    <div className="rounded-sm border border-danger/40 bg-danger-surface/40 px-3 py-2 text-xs text-danger">
      {message}
    </div>
  );
}
