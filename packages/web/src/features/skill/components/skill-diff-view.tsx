'use client';

import { useMemo } from 'react';
import { lineDiff } from '../lib/diff';

interface SkillDiffViewProps {
  /** Global SKILL.md (the "base"). */
  base: string;
  /** Project's overridden SKILL.md (the "current"). */
  current: string;
}

/**
 * Side-by-line unified diff of two SKILL.md strings. Green = added, red =
 * removed, default = unchanged. Used in the editor when a project skill is
 * an override of a global skill, so reviewers can see what was customised.
 */
export function SkillDiffView({ base, current }: SkillDiffViewProps) {
  const ops = useMemo(() => lineDiff(base, current), [base, current]);

  if (ops.every((o) => o.kind === 'eq')) {
    return (
      <div className="rounded border border-outline-variant/30 bg-surface-container-low p-3 text-xs text-outline">
        No differences — override matches the global skill exactly.
      </div>
    );
  }

  return (
    <div className="rounded border border-outline-variant/30 bg-surface-container-low font-mono text-xs">
      <div className="flex border-b border-outline-variant/20 bg-surface-container-low px-3 py-1.5 text-[10px] uppercase tracking-wide text-outline">
        <span className="flex-1">Diff vs global</span>
        <span className="flex items-center gap-3">
          <span className="text-success">+ added</span>
          <span className="text-danger">- removed</span>
        </span>
      </div>
      <pre className="m-0 max-h-[400px] overflow-auto px-3 py-2 leading-snug">
        {ops.map((op, i) => {
          const prefix = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ';
          const cls =
            op.kind === 'add'
              ? 'block bg-success-surface/30 text-success'
              : op.kind === 'del'
                ? 'block bg-danger-surface/30 text-danger'
                : 'block text-on-surface-variant';
          return (
            <span key={i} className={cls}>
              {prefix} {op.text || ' '}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
