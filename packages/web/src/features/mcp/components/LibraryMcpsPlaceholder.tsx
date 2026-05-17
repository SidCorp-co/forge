'use client';

import { Library } from 'lucide-react';

export function LibraryMcpsPlaceholder() {
  return (
    <section className="rounded-sm border border-dashed border-outline-variant/50 bg-surface-container-low p-5">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-surface-container-high">
          <Library className="h-3.5 w-3.5 text-outline" />
        </div>
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-outline">
          Library MCPs
        </h2>
      </div>
      <p className="text-[12px] leading-relaxed text-on-surface-variant">
        Shared MCPs available to enable per-project — coming soon.
      </p>
    </section>
  );
}
