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

// cm:why this reads resolve.ts's TEXT rather than importing it: that module pulls in the db client
// and env at module load, so a test importing it would need a database to assert which function
// builds a pure array. ISS-1066 kept a second copy of the rule in that file behind a parity test,
// because a file another run holds is not its to edit; ISS-1048 collapsed the copy on landing, and
// what is worth guarding now is the wiring that collapse created rather than the drift it prevented.
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
