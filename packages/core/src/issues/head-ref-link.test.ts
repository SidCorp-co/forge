import { describe, expect, it } from 'vitest';
import {
  branchIssueReferences,
  CHANGE_REQUEST_LINK_RULE,
  deliveredDescriptionReferences,
  noIssueReason,
  readingOfLink,
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

  it('reads the one key a feat|fix delivery branch ends with (REQ-63 BC-4 r11)', () => {
    expect(keys(branchIssueReferences('feat/x-iss-16'))).toEqual(['ISS-16']);
    expect(keys(branchIssueReferences('fix/req4-token-iss-4'))).toEqual(['ISS-4']);
  });

  // adminhub-api MR 5162 (FB-528): a run's attempt number after the key read as a second issue, and
  // its merge stamped ISS-2, closed and unrelated (ISS-1027)
  it('reads a digit suffix after the key as no second key', () => {
    expect(keys(branchIssueReferences('fix/strict-check-recursive-not-iss-50-2'))).toEqual([
      'ISS-50',
    ]);
    expect(keys(branchIssueReferences('feat/x-iss-16-31'))).toEqual(['ISS-16']);
    expect(keys(branchIssueReferences('fix/iss-50-2'))).toEqual(['ISS-50']);
  });

  it('tells the leading key from the tail key', () => {
    expect(branchIssueReferences('fix/iss-37-x').map((r) => r.from)).toEqual(['lead']);
    expect(branchIssueReferences('feat/x-iss-16').map((r) => r.from)).toEqual(['tail']);
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

// ISS-980 (FB-500, epod !139 and !138): titled `Draft: ISS-70: …` on `batch-ISS-70`, it linked
// nothing, and `batch-ISS-54-69` linked ISS-69 alone
describe('ISS-980: a draft marker hides no key, and a batch branch links every key it lists', () => {
  it('reads past each draft marker a host writes before the title', () => {
    for (const title of [
      'Draft: ISS-70: lift the hold',
      '[Draft] ISS-70 lift the hold',
      'WIP: ISS-70 lift the hold',
      'Draft - ISS-70: lift the hold',
      '(Draft) ISS-70: lift the hold',
      'Draft: [WIP] ISS-70: lift the hold',
      'draft:ISS-70 lift the hold',
    ]) {
      expect(keys(titleIssueReferences(title)), title).toEqual(['ISS-70']);
    }
  });

  it('reads past a marker to a listed lead, and a key in prose after one stays prose', () => {
    expect(keys(titleIssueReferences('Draft: ISS-54, ISS-69 — one batch'))).toEqual([
      'ISS-54',
      'ISS-69',
    ]);
    expect(titleIssueReferences('Draft: port the work ISS-4 started')).toEqual([]);
    expect(titleIssueReferences('Drafting ISS-4 copy')).toEqual([]);
  });

  it('links every key a batch-<keys> branch lists, in order', () => {
    expect(keys(branchIssueReferences('batch-ISS-70'))).toEqual(['ISS-70']);
    expect(keys(branchIssueReferences('batch-ISS-54-69'))).toEqual(['ISS-54', 'ISS-69']);
    expect(keys(branchIssueReferences('batch-iss-49-53-60'))).toEqual([
      'ISS-49',
      'ISS-53',
      'ISS-60',
    ]);
    expect(keys(branchIssueReferences('batch-ISS-1-ISS-2'))).toEqual(['ISS-1', 'ISS-2']);
    expect(keys(branchIssueReferences('ops/batch-ISS-103'))).toEqual(['ISS-103']);
  });

  it('reads the first batch key as the lead and the ones listed after it as the tail', () => {
    expect(branchIssueReferences('batch-ISS-54-69').map((r) => r.from)).toEqual(['lead', 'tail']);
    expect(readingOfLink('batch-ISS-54-69', 54, 'head-ref')).toBe('branch-lead');
    expect(readingOfLink('batch-ISS-54-69', 69, 'head-ref')).toBe('branch-tail');
  });

  it('reads nothing from a batch branch that lists no key', () => {
    expect(branchIssueReferences('batch-ui-b')).toEqual([]);
    expect(branchIssueReferences('batch/iss1060-1061')).toEqual([]);
    expect(branchIssueReferences('batch-ISS-54-69-ui')).toEqual([]);
  });

  it('names the branch shapes, the title lead past a draft marker and the description in its rule', () => {
    for (const shape of ['batch-iss-n-m', 'Draft:', '[Draft]', 'WIP:', 'Closes ISS-n', 'fix/iss-n']) {
      expect(CHANGE_REQUEST_LINK_RULE, shape).toContain(shape);
    }
    const why = noIssueReason({ headRef: 'chore/x', title: 'x', description: null, prefixes: ['ISS'] });
    expect(why).toContain(CHANGE_REQUEST_LINK_RULE);
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

describe('readingOfLink: which reading of a change request named a linked issue (ISS-1027)', () => {
  it('names the branch lead, the branch tail, the title and the body', () => {
    expect(readingOfLink('fix/iss-37-x', 37, 'head-ref')).toBe('branch-lead');
    expect(readingOfLink('feat/x-iss-16', 16, 'head-ref')).toBe('branch-tail');
    expect(readingOfLink('feat/x-iss-16', 31, 'title')).toBe('title');
    expect(readingOfLink('feat/x-iss-16', 31, 'description')).toBe('body');
  });

  it('reads a key both the lead and the tail hold as the lead', () => {
    expect(readingOfLink('fix/iss-7-x-iss-7', 7, 'head-ref')).toBe('branch-lead');
  });
});
