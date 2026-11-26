import { describe, expect, it } from 'vitest';
import { ISSUE_FLOW_GUIDE } from '../guides/issue-flow-guide.js';
import { QA_GUIDE } from '../guides/qa-guide.js';
import {
  citationSentence,
  type HeldAttachments,
  unresolvedCitations,
} from './evidence-standing.js';

const HELD_ID = '0d91ae7c-74f7-4295-8de1-15463b17559e';
const OTHER_ID = '9a1b2c3d-1111-4222-8333-444455556666';
const held: HeldAttachments = { names: new Set(['judge-log.txt']), ids: new Set([HELD_ID]) };
const COMMIT = '0d91ae7c74f70295ede115463b17559e650b5207';

describe('a citation of an attachment this issue holds resolves in all three spellings', () => {
  it('holds its file name, its id and its download URL, relative or whole', () => {
    const cited = [
      'judge-log.txt',
      HELD_ID,
      HELD_ID.toUpperCase(),
      `/api/attachments/${HELD_ID}/download`,
      `https://forge.example.test/api/attachments/${HELD_ID}/download`,
    ];
    expect(unresolvedCitations(cited, held)).toEqual([]);
  });

  it('names the id and the URL of an attachment the issue does not hold, never silently', () => {
    const out = unresolvedCitations(
      [OTHER_ID, `/api/attachments/${OTHER_ID}/download`, 'gone.txt'],
      held,
    );
    expect(out.map((r) => r.standing)).toEqual(['dangling', 'dangling', 'dangling']);
    expect(citationSentence(out)).toBe(
      `its evidence does not resolve: \`${OTHER_ID}\` names no attachment this issue holds, and \`/api/attachments/${OTHER_ID}/download\` names no attachment this issue holds, and \`gone.txt\` names no attachment this issue holds`,
    );
  });

  it('keeps a 40-hex commit identity and another URL as what they were, not dangling', () => {
    expect(unresolvedCitations([COMMIT, 'https://example.test/run/1'], held)).toEqual([]);
  });
});

describe('the guides name the forms the weighing resolves', () => {
  it('says name, id and download URL, and the unresolved answer', () => {
    for (const guide of [QA_GUIDE, ISSUE_FLOW_GUIDE]) {
      const prose = guide.body.split(/\s+/).join(' ');
      expect(prose).toContain('/api/attachments/:id/download');
      expect(prose).toContain('unresolved');
    }
  });
});
