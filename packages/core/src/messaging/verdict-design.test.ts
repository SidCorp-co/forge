/**
 * The write door for whether the design a verdict names is one its issue's project holds.
 */

import { describe, expect, it } from 'vitest';
import { parseForgeRecord } from './forge-record.js';
import { RECORD_RULE_IDS, recordRefusals } from './record-screen.js';
import {
  type DesignLookup,
  type DesignLookupResult,
  verdictDesignRefusals,
} from './verdict-design.js';

const FENCE = '```';
const HOP = 'd180bdca-a927-4b11-b370-fa2ec923dba4';
const OTHER = '11111111-1111-4111-8111-111111111111';
const WORKFLOW = 'b2eb2792-a043-4d5f-80a3-50a32c29e6e9';

const record = (lines: string[]) =>
  parseForgeRecord(
    [`${FENCE}forge-record`, ...lines, FENCE, '', '`forge-record: verdict · contract 1`'].join(
      '\n',
    ),
  );

const verdict = (design: string) =>
  record(['criterion: 2', 'verdict: pass', `design: ${design}`, 'evidence: readback.json']);

/** The project holds `discharge-post-care` at revision 4, with designs 2 and 4 put to its approver. */
const lookup: DesignLookup = async (projectId, workflow): Promise<DesignLookupResult> => {
  if (workflow === 'discharge-post-care' && projectId === HOP) {
    return {
      kind: 'found',
      design: { id: WORKFLOW, flow: 'discharge-post-care', projectId: HOP, revisions: [4, 2] },
    };
  }
  if (workflow === WORKFLOW) {
    return {
      kind: 'found',
      design: { id: WORKFLOW, flow: 'discharge-post-care', projectId: HOP, revisions: [4, 2] },
    };
  }
  return { kind: 'missing', flows: projectId === HOP ? ['discharge-post-care'] : [] };
};

describe('verdict-design', () => {
  it('declares its own rule id beside the others the record screen owns', () => {
    expect(RECORD_RULE_IDS).toContain('verdict-design');
  });

  it('accepts the current revision and a stored one, by flow and by id', async () => {
    for (const design of [
      'discharge-post-care rev 4',
      'discharge-post-care rev 2',
      `${WORKFLOW} rev 4`,
    ]) {
      expect(await verdictDesignRefusals(HOP, verdict(design), lookup), design).toEqual([]);
    }
  });

  it('refuses a design the project does not hold, naming the flows it does', async () => {
    const [refusal, ...rest] = await verdictDesignRefusals(HOP, verdict('no-such rev 1'), lookup);
    expect(rest).toEqual([]);
    expect(refusal?.rule).toBe('verdict-design');
    expect(refusal?.why).toContain('criterion 2 names design `no-such` rev 1');
    expect(refusal?.why).toContain('holds no workflow with that flow or id');
    expect(refusal?.why).toContain('`discharge-post-care`');
    expect(refusal?.quote).toBe('design: no-such rev 1');
    expect(refusal?.shape).toContain("this issue's own project");
    expect(refusal?.example).toContain('design: ');
  });

  it('refuses a revision the workflow does not hold, naming the ones it does', async () => {
    const [refusal] = await verdictDesignRefusals(
      HOP,
      verdict('discharge-post-care rev 3'),
      lookup,
    );
    expect(refusal?.rule).toBe('verdict-design');
    expect(refusal?.why).toContain('holds no revision 3');
    expect(refusal?.why).toContain('`2`, `4`');
  });

  it('refuses a design of another project, by name rather than as missing', async () => {
    const [refusal] = await verdictDesignRefusals(OTHER, verdict(`${WORKFLOW} rev 4`), lookup);
    expect(refusal?.rule).toBe('verdict-design');
    expect(refusal?.why).toContain('of another project');
  });

  it('looks nothing up for a block naming no design, or one verdict-identity already refuses', async () => {
    let asked = 0;
    const counting: DesignLookup = async (p, w) => {
      asked += 1;
      return lookup(p, w);
    };
    await verdictDesignRefusals(
      HOP,
      record(['criterion: 1', 'verdict: pass', 'commit: aaaaaaa']),
      counting,
    );
    await verdictDesignRefusals(HOP, verdict('discharge-post-care'), counting);
    expect(asked).toBe(0);
  });

  it('is part of what the record screen refuses a comment for', async () => {
    const refusals = await recordRefusals(
      HOP,
      verdict('discharge-post-care rev 9'),
      undefined,
      lookup,
    );
    expect(refusals.map((r) => r.rule)).toEqual(['verdict-design']);
    expect(
      await recordRefusals(HOP, verdict('discharge-post-care rev 4'), undefined, lookup),
    ).toEqual([]);
  });
});
