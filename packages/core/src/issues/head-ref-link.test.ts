import { describe, expect, it } from 'vitest';
import {
  branchIssueReferences,
  deliveredDescriptionReferences,
  noIssueReason,
  titleIssueReferences,
} from './head-ref-link.js';

const keys = (refs: Array<{ prefix: string; issSeq: number }>) =>
  refs.map((r) => `${r.prefix}-${r.issSeq}`);

describe('branchIssueReferences: the keys a branch names, in order (ISS-705, REQ-63 BC-4)', () => {
  it('reads a key opening the branch or any path segment', () => {
    expect(keys(branchIssueReferences('fix/iss-37-gitlab-merge-delivery'))).toEqual(['ISS-37']);
    expect(keys(branchIssueReferences('iss-37-cr-links'))).toEqual(['ISS-37']);
    expect(keys(branchIssueReferences('ISS-37'))).toEqual(['ISS-37']);
  });

  it('reads the numbers a feat|fix delivery branch ends with', () => {
    expect(keys(branchIssueReferences('feat/req3-site-write-iss-1-2'))).toEqual(['ISS-1', 'ISS-2']);
    expect(keys(branchIssueReferences('fix/req4-token-iss-4'))).toEqual(['ISS-4']);
  });

  it('reads nothing from a branch that names no key', () => {
    expect(branchIssueReferences('chore/bump-deps')).toEqual([]);
    expect(branchIssueReferences('fix/iss705-cr-links')).toEqual([]);
    expect(branchIssueReferences('fix/iss-0-x')).toEqual([]);
  });
});

describe('deliveredDescriptionReferences: only a delivery form delivers (ISS-705)', () => {
  it('reads the !1979 description as delivering ISS-37 alone', () => {
    const body = [
      'Closes ISS-37.',
      '',
      'The beta carries the same defect as ISS-38, which lands in its own merge request.',
      'This calls the two endpoints adminhub-api ISS-11 and adminhub-api ISS-18 added:',
      '- adminhub-api ISS-11',
      '- adminhub-api ISS-18',
    ].join('\n');
    expect(keys(deliveredDescriptionReferences(body))).toEqual(['ISS-37']);
  });

  it('reads a key alone on its line, bulleted, numbered, quoted or emphasised', () => {
    const body = 'ISS-1\n- ISS-2, ISS-3 and ISS-4\n2. ISS-5;\n> * ISS-6\n- [x] **ISS-7**\n`ISS-8`';
    expect(keys(deliveredDescriptionReferences(body))).toEqual([
      'ISS-1',
      'ISS-2',
      'ISS-3',
      'ISS-4',
      'ISS-5',
      'ISS-6',
      'ISS-7',
      'ISS-8',
    ]);
  });

  it('reads the keys right after a closing verb, in any tense, and stops at the first other word', () => {
    expect(keys(deliveredDescriptionReferences('Also delivers ISS-3. Serves REQ-4.'))).toEqual([
      'ISS-3',
    ]);
    expect(
      keys(deliveredDescriptionReferences('Fixes: ISS-4 and ISS-5, adminhub-api ISS-11')),
    ).toEqual(['ISS-4', 'ISS-5']);
    expect(
      keys(deliveredDescriptionReferences('This resolved iss-9 and implements ISS-10')),
    ).toEqual(['ISS-9', 'ISS-10']);
  });

  it('keeps the order the description gives, not the numeric one', () => {
    expect(keys(deliveredDescriptionReferences('Delivers:\n- ISS-38\n- ISS-18'))).toEqual([
      'ISS-38',
      'ISS-18',
    ]);
  });

  it('reads nothing from prose, a qualified key, or a word that only contains a verb', () => {
    expect(deliveredDescriptionReferences('Bumps the client the way ISS-11 asked for.')).toEqual(
      [],
    );
    expect(deliveredDescriptionReferences('adminhub-api ISS-11')).toEqual([]);
    expect(deliveredDescriptionReferences('Closes adminhub-api ISS-11')).toEqual([]);
    expect(deliveredDescriptionReferences('Leaves the unresolved ISS-5 alone')).toEqual([]);
    expect(deliveredDescriptionReferences('Branch: fix/iss-37-x')).toEqual([]);
    expect(deliveredDescriptionReferences('ISS-37ISS-38')).toEqual([]);
  });

  it("reads another project's prefix as a key and leaves it to the caller's held prefixes", () => {
    expect(keys(deliveredDescriptionReferences('Closes AH-11\nAH-18'))).toEqual(['AH-11', 'AH-18']);
  });
});

// ISS-855 (FB-460, epod !97): titled 'ISS-31: …; ISS-24: …' on a keyless branch, linked nothing.
describe('titleIssueReferences: the keys a title leads with, lists or closes (REQ-63 BC-4)', () => {
  it('reads the !97 title as delivering ISS-31 and ISS-24, in order', () => {
    expect(
      keys(titleIssueReferences('ISS-31: tracking apikey error; ISS-24: domain wording')),
    ).toEqual(['ISS-31', 'ISS-24']);
  });

  it('reads a bracketed or listed lead, and keys after a closing verb', () => {
    expect(keys(titleIssueReferences('[ISS-12] fix login'))).toEqual(['ISS-12']);
    expect(keys(titleIssueReferences('ISS-1, ISS-2 and ISS-3 — one change'))).toEqual([
      'ISS-1',
      'ISS-2',
      'ISS-3',
    ]);
    expect(keys(titleIssueReferences('Login copy (fixes ISS-9)'))).toEqual(['ISS-9']);
  });

  it("reads nothing from prose or a key under another project's name (FB-295)", () => {
    expect(titleIssueReferences('Port the work ISS-4 started')).toEqual([]);
    expect(titleIssueReferences('Call adminhub-api ISS-11 from the widget')).toEqual([]);
    expect(titleIssueReferences('chore: bump deps')).toEqual([]);
  });
});

describe('noIssueReason: an MR that links nothing says what was read (ISS-855)', () => {
  it('names the branch, the title, the description and the shapes that link', () => {
    const why = noIssueReason({
      headRef: 'fix/tracking-apikey-error-domain-wording',
      title: 'Tracking copy',
      description: 'Wording only.',
      prefixes: ['ISS'],
    });
    expect(why).toContain('fix/tracking-apikey-error-domain-wording');
    expect(why).toContain('Tracking copy');
    expect(why).toContain('ISS-n');
    expect(why).toMatch(/description/);
  });

  it("names a key it read that is no issue of this project, or another project's", () => {
    const why = noIssueReason({
      headRef: 'fix/iss-4000-x',
      title: 'REQ-4: something',
      description: null,
      prefixes: ['ISS'],
    });
    expect(why).toContain('ISS-4000');
    expect(why).toContain('REQ-4');
  });
});
