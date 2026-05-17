'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import {
  CLIENTS,
  type ClientKind,
  type SnippetInput,
  generateSnippet,
} from '../lib/snippet-generators';
import { SnippetCard } from './SnippetCard';

interface Props {
  input: SnippetInput;
}

export function ClientTabs({ input }: Props) {
  const [active, setActive] = useState<ClientKind>('claude-cli');
  const snippet = useMemo(() => generateSnippet(active, input), [active, input]);

  return (
    <section>
      <div
        role="tablist"
        aria-label="MCP client"
        className="mb-3 flex flex-wrap gap-1 border-b border-outline-variant/30"
      >
        {CLIENTS.map((client) => {
          const isActive = client.kind === active;
          return (
            <button
              key={client.kind}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(client.kind)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[11px] font-bold uppercase tracking-widest transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-outline hover:text-on-surface',
              )}
            >
              {client.label}
            </button>
          );
        })}
      </div>
      <SnippetCard snippet={snippet} />
    </section>
  );
}
