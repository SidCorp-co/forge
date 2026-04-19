'use client';

import { useState } from 'react';
import type { KnowledgeIndex } from '@/features/project/types';

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-outline-variant/20 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-container-low"
      >
        <span className="text-xs text-outline">{open ? 'v' : '>'}</span>
        <span className="font-medium text-on-surface">{label}</span>
      </button>
      {open && <div className="px-6 pb-3 text-xs text-on-surface-variant space-y-1">{children}</div>}
    </div>
  );
}

export function KnowledgeTreeView({ index }: { index: KnowledgeIndex }) {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low">
      {index.project && (
        <div className="border-b border-outline-variant/30 px-3 py-2">
          <p className="text-sm text-on-surface">{index.project}</p>
        </div>
      )}
      {index.architecture && (
        <div className="border-b border-outline-variant/30 px-3 py-2">
          <p className="text-xs text-primary-fixed">{index.architecture}</p>
        </div>
      )}
      {index.conventions && Object.keys(index.conventions).length > 0 && (
        <Section label="Conventions">
          {Object.entries(index.conventions).map(([k, v]) => (
            <p key={k}><span className="font-medium">{k}:</span> {v}</p>
          ))}
        </Section>
      )}
      {index.recipes && Object.keys(index.recipes).length > 0 && (
        <Section label="Recipes">
          {Object.entries(index.recipes).map(([k, v]) => (
            <p key={k}><span className="font-medium">{k}:</span> {v}</p>
          ))}
        </Section>
      )}
      {index.paths && Object.keys(index.paths).length > 0 && (
        <Section label="Path Templates">
          {Object.entries(index.paths).map(([k, v]) => (
            <p key={k}><span className="font-medium">{k}:</span> <code className="bg-surface-container-high px-1 rounded">{v}</code></p>
          ))}
        </Section>
      )}
      {index.domains && Object.keys(index.domains).length > 0 && (
        <Section label="Domains">
          {Object.entries(index.domains).map(([k, resources]) => (
            <div key={k}>
              <span className="font-medium">{k}:</span>
              <span className="ml-1 text-primary-fixed">{resources.join(', ')}</span>
            </div>
          ))}
        </Section>
      )}
      {index.commands && Object.keys(index.commands).length > 0 && (
        <Section label="Commands">
          {Object.entries(index.commands).map(([k, v]) => (
            <p key={k}><code className="bg-surface-container-high px-1 rounded">{k}</code>: {v}</p>
          ))}
        </Section>
      )}
    </div>
  );
}
