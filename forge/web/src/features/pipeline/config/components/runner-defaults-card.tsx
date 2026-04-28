'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Select } from '@/components/ui';

interface Props {
  chain: string[];
  availableTypes: string[];
  onChange: (chain: string[]) => void;
}

export function RunnerDefaultsCard({ chain, availableTypes, onChange }: Props) {
  const candidates = availableTypes.filter((t) => !chain.includes(t));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= chain.length) return;
    const next = chain.slice();
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    onChange(next);
  };

  return (
    <div className="bg-surface-container-low border border-outline-variant/30 p-6 space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-on-surface">Runner fallback chain</h3>
        <p className="text-xs text-on-surface-variant">
          Project-level default order the dispatcher tries when assigning a job. Per-step overrides
          (above) prepend onto this chain.
        </p>
      </div>

      <ul className="space-y-2">
        {chain.length === 0 && (
          <li className="text-xs text-on-surface-variant italic">
            No runners — the dispatcher will fall back to <code>claude-code</code>.
          </li>
        )}
        {chain.map((type, i) => (
          <li
            key={type}
            className="flex items-center gap-2 border border-outline-variant/20 px-3 py-2 bg-surface"
          >
            <span className="text-[10px] font-mono text-on-surface-variant w-4 shrink-0">
              {i + 1}
            </span>
            <span className="text-sm text-on-surface flex-1 font-mono">{type}</span>
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="p-1 text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed"
              title="Move up"
              aria-label={`Move ${type} up`}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === chain.length - 1}
              className="p-1 text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed"
              title="Move down"
              aria-label={`Move ${type} down`}
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChange(chain.filter((_, j) => j !== i))}
              className="p-1 text-on-surface-variant hover:text-error"
              title="Remove"
              aria-label={`Remove ${type}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {candidates.length > 0 && (
        <div className="flex items-center gap-2 pt-2 border-t border-outline-variant/15">
          <Plus className="h-3.5 w-3.5 text-on-surface-variant" />
          <Select
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              onChange([...chain, e.target.value]);
            }}
            className="h-8 text-xs flex-1"
          >
            <option value="">Add runner type…</option>
            {candidates.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
