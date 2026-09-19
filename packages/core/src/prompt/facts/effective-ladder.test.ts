import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { effectivePipelineStates } from './effective-ladder.js';
import { CANONICAL_LADDER } from './registry.js';

describe('effectivePipelineStates (ISS-1066)', () => {
  it('reads the whole canonical sequence back from a config naming only open', () => {
    expect(effectivePipelineStates({ open: { enabled: true } })).toEqual([...CANONICAL_LADDER]);
  });

  it('reads the whole canonical sequence back from an absent or empty config', () => {
    expect(effectivePipelineStates(undefined)).toEqual([...CANONICAL_LADDER]);
    expect(effectivePipelineStates(null)).toEqual([...CANONICAL_LADDER]);
    expect(effectivePipelineStates({})).toEqual([...CANONICAL_LADDER]);
  });

  it('drops a stage the project switched off, and keeps the order of the rest', () => {
    const states = effectivePipelineStates({ awaiting_release: { enabled: false } });
    expect(states).not.toContain('awaiting_release');
    expect(states).toEqual(CANONICAL_LADDER.filter((s) => s !== 'awaiting_release'));
  });

  it('drops several, and a stage named with enabled true or omitted is kept', () => {
    expect(
      effectivePipelineStates({
        open: { enabled: true },
        in_progress: {},
        needs_info: { enabled: false },
        awaiting_release: { enabled: false },
      }),
    ).toEqual(CANONICAL_LADDER.filter((s) => s !== 'awaiting_release'));
  });

  it('ignores a key that is not a rung of the ladder', () => {
    expect(effectivePipelineStates({ needs_info: { enabled: false } })).toEqual([
      ...CANONICAL_LADDER,
    ]);
  });
});

describe('the resolver builds its ladder from this function (ISS-1048)', () => {
  const resolveSource = readFileSync(new URL('./resolve.ts', import.meta.url), 'utf8');

  it('calls this function for the ladder it resolves', () => {
    expect(resolveSource).toContain('ladder: effectivePipelineStates(states)');
  });

  it('holds no ladder filter of its own, so the duplicate cannot quietly come back', () => {
    const copies = resolveSource.match(/CANONICAL_LADDER\.filter\(/g) ?? [];
    expect(copies).toHaveLength(0);
  });
});
