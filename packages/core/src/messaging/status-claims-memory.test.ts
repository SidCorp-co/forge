import { describe, expect, it } from 'vitest';
import { facts } from './facts.js';
import { GROUNDING_TOOLS, memoryDatesRead, STATUS_CLAIMS_GROUNDED } from './status-claims-rule.js';

// MJ-5: a memory is a dated source, never a current fact. A decision the reply takes from a memory
// read this turn is grounded only when the reply names that memory's date; a memory never grounds
// what shipped, how far a requirement is, what comes next or what is late, dated or not.

const OFFERED = ['forge', 'forge_memory', ...Object.values(GROUNDING_TOOLS)];
const call = (name: string, isError = false) => ({ name, arguments: '{}', isError });
const MEMORY_READ = JSON.stringify({
  hits: [
    {
      sourceRef: 'policy/dev-egress-and-approval-2026-10-04',
      writtenAt: '2026-10-03T17:02:11.000Z',
      asOf: '2026-10-04T09:30:00.000Z',
      verifiedAt: null,
    },
  ],
});
const dated = (calls = [call('forge_memory')]) =>
  facts({ toolCalls: calls, offeredTools: OFFERED, memoryDates: memoryDatesRead([MEMORY_READ]) });
const check = (reply: string, f = dated()) => STATUS_CLAIMS_GROUNDED.check(reply, f);

describe('a decision cited from memory with its date', () => {
  it('reads the dates a memory search returned, and none from another read', () => {
    expect([...memoryDatesRead([MEMORY_READ])].sort()).toEqual(['2026-10-03', '2026-10-04']);
    expect([...memoryDatesRead(['{"updatedAt":"2026-10-04T00:00:00Z"}'])]).toEqual([]);
  });

  it.each([
    'A memory of 2026-10-04 records that the owner decided to drop no_egress on dev.',
    'Per a note dated Oct 4, the owner decided to drop no_egress on dev.',
    'Ghi nhớ ngày 4/10 ghi lại: chủ dự án đã quyết định bỏ no_egress trên dev.', // i18n-allow: a Vietnamese reply citing a memory's date
  ])('grounds %s', (reply) => {
    expect(check(reply)).toEqual([]);
  });

  it('refuses the same decision stated with no date, as a current fact', () => {
    const breaks = check('The owner decided to drop no_egress on dev.');
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.why).toMatch(/memory .* its date/);
  });

  it('refuses a date that no memory read this turn carries', () => {
    expect(
      check('A memory of 2026-09-01 records that the owner decided to drop no_egress.'),
    ).toHaveLength(1);
  });

  it('refuses when the memory read was refused', () => {
    expect(
      check(
        'A memory of 2026-10-04 records the owner decided to drop no_egress.',
        dated([call('forge_memory', true)]),
      ),
    ).toHaveLength(1);
  });

  it('never grounds what shipped from memory, dated or not', () => {
    const breaks = check('A memory of 2026-10-04 says release 0.2.0 shipped to users.');
    expect(breaks.map((b) => b.why).join(' ')).toMatch(/what shipped/);
  });
});
