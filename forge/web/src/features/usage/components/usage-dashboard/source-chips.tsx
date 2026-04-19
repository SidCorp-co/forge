'use client';

export function SourceChips({
  sources,
  active,
  onToggle,
}: {
  sources: { source: string }[];
  active: Set<string>;
  onToggle: (s: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((s) => {
        const on = active.has(s.source);
        return (
          <button
            key={s.source}
            onClick={() => onToggle(s.source)}
            className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium capitalize transition-all ${
              on
                ? 'border-surface bg-surface text-on-surface'
                : 'border-outline-variant/30 bg-surface-container-low text-outline hover:border-outline-variant hover:text-on-surface-variant'
            }`}
          >
            {s.source}
          </button>
        );
      })}
    </div>
  );
}
