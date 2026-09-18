/**
 * The record screen: the budget, and which cell reads a lead.
 *
 * The lens cases are written against the SHAPE of the two queries rather than
 * against a live row, because the proposition each one asserts is which cell a
 * project resolves to — and a cell is chosen from what the two queries return,
 * not from how they are spelled (ISS-1089).
 */

import { describe, expect, it, vi } from 'vitest';

interface Answers {
  readonly orgId?: string | null;
  /** Only the rows the reader query returns — the members who can read the project. */
  readonly members?: Array<{ lenses: string[] | null; orgRole?: string }>;
  readonly throws?: boolean;
}

let answers: Answers = {};

// cm:guard the two reads are told apart by `innerJoin`, which only the member query calls. Keying
// on call order instead would pass while the code asked its questions the other way round, which is
// the one thing these cases are about.
const handle = {
  select: () => ({
    from: () => {
      if (answers.throws) throw new Error('the pool is gone');
      return {
        where: () => ({ limit: async () => (answers.orgId ? [{ orgId: answers.orgId }] : []) }),
        innerJoin: () => ({
          leftJoin: () => ({ where: async () => answers.members ?? [] }),
        }),
      };
    },
  }),
};

vi.mock('../db/client.js', () => ({ db: handle }));

const { projectLeadAudience, budgetRefusals, screenLead, recordRefusals, RECORD_RULE_IDS } =
  await import('./record-screen.js');
const { FORGE_RECORD_FIELD_BUDGET, parseForgeRecord } = await import('./forge-record.js');
const { ROLE_PRODUCT, ROLE_TECHNICAL } = await import('./audiences.js');

const fence = '```';
const record = (body: string): string =>
  `${fence}forge-record\n${body}\n${fence}\n\n\`forge-record: confirmation · contract 1\``;
const parsed = (body: string) => parseForgeRecord(record(body));

const lensed = (a: Answers) => {
  answers = a;
  return projectLeadAudience('proj-1');
};

describe('which reading a project resolves to', () => {
  it('reads as technical where one human member carries the lens', async () => {
    expect(
      await lensed({ orgId: 'org-1', members: [{ lenses: [] }, { lenses: ['technical'] }] }),
    ).toBe(ROLE_TECHNICAL);
  });

  it('reads as product where every human member reads as product', async () => {
    expect(await lensed({ orgId: 'org-1', members: [{ lenses: ['product'] }] })).toBe(ROLE_PRODUCT);
  });

  it('reads as product where no member carries any lens at all', async () => {
    expect(await lensed({ orgId: 'org-1', members: [{ lenses: [] }, { lenses: null }] })).toBe(
      ROLE_PRODUCT,
    );
  });

  // cm:guard the query asks about members who can READ this project, which is `lib/authz.ts`'s rule:
  // a `project_members` row, or an org owner/admin. Plain org membership derives no project access
  // there, and counting it here would let one technical person anywhere in a large organization
  // unfold every card on a project whose own readers are all product (codex F1). The stub returns
  // only the rows that query selects, so a reader who widened the predicate would still red the
  // next case rather than this one.
  it('reads the lens off the members the reader query returned, and nobody else', async () => {
    expect(
      await lensed({ orgId: 'org-1', members: [{ lenses: ['product'], orgRole: 'member' }] }),
    ).toBe(ROLE_PRODUCT);
  });

  it('reads as technical where a project member carries the lens', async () => {
    expect(
      await lensed({ orgId: 'org-1', members: [{ lenses: ['technical'], orgRole: 'member' }] }),
    ).toBe(ROLE_TECHNICAL);
  });

  it('reads as product where nobody can read the project at all', async () => {
    expect(await lensed({ orgId: 'org-1', members: [] })).toBe(ROLE_PRODUCT);
  });

  it('reads as product where the project belongs to no organization', async () => {
    expect(await lensed({ orgId: null })).toBe(ROLE_PRODUCT);
  });

  // cm:guard failing CLOSED, to the stricter cell, is the property this case holds: a read that
  // threw must not become permission to write developer detail to people who cannot read it.
  it('reads as product where the read itself fails', async () => {
    expect(await lensed({ throws: true })).toBe(ROLE_PRODUCT);
  });
});

describe('the budget, at the door', () => {
  const at = 'x'.repeat(FORGE_RECORD_FIELD_BUDGET);
  const over = 'x'.repeat(FORGE_RECORD_FIELD_BUDGET + 57);

  it('admits a field of exactly the budget', () => {
    expect(budgetRefusals(parsed(`why: ${at}`))).toEqual([]);
  });

  it('refuses a field one character past it', () => {
    expect(budgetRefusals(parsed(`why: ${at}x`))).toHaveLength(1);
  });

  it('names the key the refusal is about', () => {
    expect(budgetRefusals(parsed(`why: ${over}`))[0]?.quote).toBe('why');
  });

  it('states how far over the budget the field runs', () => {
    expect(budgetRefusals(parsed(`why: ${over}`))[0]?.why).toContain('57 character(s) over');
  });

  it('refuses every over-budget field rather than only the first', () => {
    const both = budgetRefusals(parsed(`why: ${over}\nis: ${over}`));
    expect(both.map((r) => r.quote)).toEqual(['why', 'is']);
  });

  // cm:guard the shape ISS-1089's own review named as the one a writer cannot answer — a
  // machine-derived path list on a `merged` record — is refused on the same terms as prose, and
  // this case is here so that behaviour is PROVED rather than assumed. The price and the constant
  // that reverses it are on the issue; if this ever has to change, change it here first.
  it('refuses a machine-derived path list on the same terms as prose', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `packages/core/src/module-${i}/file.ts`);
    const refusals = budgetRefusals(parsed(`moved: ${paths.join(', ')}`));
    expect(refusals.map((r) => r.rule)).toEqual(['field-budget']);
  });

  it('measures nothing where the comment carries no record', () => {
    expect(budgetRefusals(null)).toEqual([]);
  });

  it('owns exactly the rules the document has to name', () => {
    expect([...RECORD_RULE_IDS]).toEqual(['field-budget']);
  });
});

describe('the lead, screened alone', () => {
  it('refuses a lead with no text, naming the lead', () => {
    const verdict = screenLead('   ', ROLE_PRODUCT);
    expect(verdict.ok ? [] : verdict.refusals.map((r) => r.rule)).toEqual(['lead-has-text']);
  });

  it('refuses a blank lead on a technical project too', () => {
    const verdict = screenLead('', ROLE_TECHNICAL);
    expect(verdict.ok ? [] : verdict.refusals.map((r) => r.rule)).toEqual(['lead-has-text']);
  });

  it('reads a product lead against no-developer-detail', () => {
    const verdict = screenLead(
      'The fix is in packages/core/src/comments/screen.ts:24.',
      ROLE_PRODUCT,
    );
    expect(verdict.ok ? [] : verdict.refusals.map((r) => r.rule)).toEqual(['no-developer-detail']);
  });

  it('does not read a technical lead against no-developer-detail', () => {
    const verdict = screenLead(
      'The fix is in packages/core/src/comments/screen.ts:24.',
      ROLE_TECHNICAL,
    );
    expect(verdict.ok).toBe(true);
  });

  it('admits the same sentence under both readings where it carries no developer detail', () => {
    const lead = 'The comment screen admits a wall of text as one segment.';
    expect([screenLead(lead, ROLE_PRODUCT).ok, screenLead(lead, ROLE_TECHNICAL).ok]).toEqual([
      true,
      true,
    ]);
  });
});

describe('what the door is handed', () => {
  it('screens no lead where the record carries none, and still measures the budget', async () => {
    answers = { orgId: 'org-1', members: [{ lenses: ['product'] }] };
    const long = 'x'.repeat(FORGE_RECORD_FIELD_BUDGET + 1);
    const refusals = await recordRefusals('proj-1', parsed(`detail: ${long}`));
    expect(refusals.map((r) => r.rule)).toEqual(['field-budget']);
  });

  it('screens the lead where the record carries one', async () => {
    answers = { orgId: 'org-1', members: [{ lenses: ['product'] }] };
    const refusals = await recordRefusals('proj-1', parsed('lead: See src/a.ts:12 for the cause.'));
    expect(refusals.map((r) => r.rule)).toEqual(['no-developer-detail']);
  });

  it('returns the budget refusal and the lead refusal together, budget first', async () => {
    answers = { orgId: 'org-1', members: [{ lenses: ['product'] }] };
    const long = 'x'.repeat(FORGE_RECORD_FIELD_BUDGET + 1);
    const refusals = await recordRefusals(
      'proj-1',
      parsed(`lead: See src/a.ts:12 for the cause.\ndetail: ${long}`),
    );
    expect(refusals.map((r) => r.rule)).toEqual(['field-budget', 'no-developer-detail']);
  });

  it('refuses nothing, and asks the database nothing, for a comment with no record', async () => {
    answers = { throws: true };
    expect(await recordRefusals('proj-1', null)).toEqual([]);
  });
});
