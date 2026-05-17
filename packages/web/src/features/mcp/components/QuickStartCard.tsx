'use client';

import { Zap } from 'lucide-react';

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Pick a token + project',
    body: 'Choose a Personal Access Token and the project it should scope MCP calls to.',
  },
  {
    title: 'Copy the snippet for your client',
    body: 'Five clients are pre-formatted (Claude CLI, Cursor, Cline, Zed, generic mcp.json).',
  },
  {
    title: 'Verify with Test Connection',
    body: 'Hit the button below to confirm the token reaches Forge through your browser.',
  },
];

export function QuickStartCard() {
  return (
    <section className="rounded-sm border border-outline-variant/40 bg-surface-container-lowest p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-primary/10">
          <Zap className="h-3.5 w-3.5 text-primary" />
        </div>
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary">
          30 seconds to MCP
        </h2>
      </div>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-surface-container-high text-[11px] font-bold text-primary">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-bold text-on-surface">{step.title}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-on-surface-variant">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
