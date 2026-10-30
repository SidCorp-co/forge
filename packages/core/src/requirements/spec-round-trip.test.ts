// A requirement's spec as `GET .../requirements/:req` answers it is a spec a revision write takes:
// the derived `corrected` mark on an assumption is accepted at the write and never stored, and the
// next read derives it again from the revision it is on.
import { requirementSpecSchema } from '@forge/contracts/suggestions';
import { describe, expect, it } from 'vitest';
import { withCorrections } from './assumption-corrections.js';
import { specOf } from './revision-write.js';

const assumed = {
  text: 'Summary: a one line summary the assistant assumed',
  owner: 'BA assistant',
  confirmBy: 'The author corrects the draft where it is wrong',
  field: 'summary',
  value: 'a one line summary the assistant assumed',
};

describe('a spec read back is writable as it stands', () => {
  it('reads an assistant assumption the author since changed as corrected', () => {
    const read = withCorrections(
      { tldr: 'what the author wrote instead', spec: { assumptions: [assumed] } },
      [],
    );
    expect(read.assumptions?.[0]?.corrected).toBe(true);
  });

  it('takes the read shape, corrected mark included, at the revision write', () => {
    const read = withCorrections(
      { tldr: 'what the author wrote instead', spec: { assumptions: [assumed] } },
      [],
    );
    expect(requirementSpecSchema.safeParse(read).success).toBe(true);
  });

  it('still refuses a key the spec does not have', () => {
    const parsed = requirementSpecSchema.safeParse({
      assumptions: [{ ...assumed, invented: true }],
    });
    expect(parsed.success).toBe(false);
  });

  it('stores no corrected mark, so the next read derives it from the revision it is on', () => {
    const stored = specOf({ goal: 'Problem: x', assumptions: [{ ...assumed, corrected: true }] });
    expect(stored.assumptions?.[0]).toEqual(assumed);
    expect(stored.goal).toBe('Problem: x');
    const reread = withCorrections({ tldr: assumed.value, spec: stored }, []);
    expect(reread.assumptions?.[0]?.corrected).toBe(false);
  });

  it('keeps a carried spec untouched when no assumption carries the mark', () => {
    const carried = {
      assumptions: [{ text: 'a person wrote this', owner: 'owner', confirmBy: 'by release' }],
    };
    expect(specOf(undefined, carried)).toBe(carried);
  });
});
