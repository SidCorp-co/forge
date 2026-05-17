'use client';

import type { Project } from '@forge/contracts';
import type { Pat } from '../types';
import { TokenRow } from './TokenRow';

interface Props {
  tokens: Pat[];
  projects: Project[];
  onRevoke: (id: string) => Promise<void>;
  onOpenAudit: (id: string) => void;
}

export function TokenList({ tokens, projects, onRevoke, onOpenAudit }: Props) {
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-dim">
      <div className="hidden grid-cols-12 gap-3 border-b border-outline-variant/20 px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-outline md:grid">
        <div className="col-span-3">Name</div>
        <div className="col-span-2">Scope</div>
        <div className="col-span-3">Projects</div>
        <div className="col-span-2">Last used</div>
        <div className="col-span-1">Expires</div>
        <div className="col-span-1" />
      </div>
      {tokens.map((t) => (
        <TokenRow
          key={t.id}
          token={t}
          projects={projects}
          onRevoke={() => onRevoke(t.id)}
          onOpenAudit={() => onOpenAudit(t.id)}
        />
      ))}
    </div>
  );
}
