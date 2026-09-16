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

// cm:why this reads resolve.ts's TEXT rather than importing it: `buildLadder` is private, and
// resolve.ts pulls in the db client and env at module load, so a test that imported it would need a
// database to assert a pure filter. ISS-1048 (PR #457) holds that file, so the copy could not be
// collapsed in the change that noticed it; this is what stops the two drifting in the meantime.
describe('the product’s own copy of the rule (ISS-1066)', () => {
  const resolveSource = readFileSync(new URL('./resolve.ts', import.meta.url), 'utf8');

  it('still filters the canonical ladder on the same condition this function does', () => {
    expect(resolveSource).toContain('CANONICAL_LADDER.filter((s) => states[s]?.enabled !== false)');
  });

  it('holds exactly one such filter, so a second copy in that file is caught too', () => {
    const copies = resolveSource.match(/CANONICAL_LADDER\.filter\(/g) ?? [];
    expect(copies).toHaveLength(1);
  });
});
