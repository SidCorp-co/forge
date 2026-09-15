/** ISS-1041 — an issue link the assistant emits is one the web serves. */
import { describe, expect, it } from 'vitest';
import { NO_ROLE, ROLE_HOLDER } from './audiences.js';
import { cellFor } from './cells.js';
import { facts } from './facts.js';
import { ISSUE_LINK_SHAPE } from './text-rules.js';

const UUID = '87153ba0-1d92-427d-bc28-f508a163f6a4';
const check = (text: string) => ISSUE_LINK_SHAPE.check(text, facts({}));

describe('issue-link-shape', () => {
  it('refuses a hash route with a sequence number (criterion 26)', () => {
    expect(check('See #/projects/acme/issues/24 for the details.')).toHaveLength(1);
  });

  it('names the shape in its refusal (criterion 27)', () => {
    const [b] = check('See #/projects/acme/issues/24.');
    expect(b?.why).toContain('/projects/acme/issues/<documentId>');
    expect(b?.quote).toBe('#/projects/acme/issues/24');
  });

  it('refuses a hash route even with a valid documentId (criterion 28)', () => {
    expect(check(`https://forge.example/#/projects/acme/issues/${UUID}`)).toHaveLength(1);
  });

  it('refuses an issue key in the path (criterion 29)', () => {
    const [b] = check('Filed at /projects/acme/issues/ISS-24');
    expect(b?.why).toContain('"ISS-24"');
  });

  it('passes an absolute link to the documentId (criterion 30)', () => {
    expect(check(`Tracked at https://forge.example/projects/acme/issues/${UUID}`)).toEqual([]);
  });

  it('passes a root-relative link with a query string, trailing slash or closing punctuation (criterion 31)', () => {
    expect(check(`/projects/acme/issues/${UUID}?tab=activity`)).toEqual([]);
    expect(check(`/projects/acme/issues/${UUID}/`)).toEqual([]);
    expect(check(`(see /projects/acme/issues/${UUID}).`)).toEqual([]);
  });

  // cm:guard the API's own paths, the repository's own files and other hosts' trackers are not navigation targets: a role-holder asking how the API works is answered, not refused.
  it('passes an API path (criterion 32) and a repository path (criterion 33)', () => {
    expect(check(`POST /api/issues/${UUID}/comments adds a comment.`)).toEqual([]);
    expect(check('The route lives in packages/core/src/issues/routes.ts.')).toEqual([]);
    expect(check('Upstream tracks it at https://github.com/acme/repo/issues/24.')).toEqual([]);
  });

  // cm:guard inline code is how a technical reply quotes a path, and the closing backtick is not part of the documentId (codex F3).
  it('passes a valid path in inline code and still refuses an issue key in one', () => {
    expect(check(`Open \`/projects/acme/issues/${UUID}\` in the app.`)).toEqual([]);
    expect(check('Open `/projects/acme/issues/ISS-24` in the app.')).toHaveLength(1);
  });

  it('passes a reply with no link (criterion 34)', () => {
    expect(check('Four issues are open; ISS-2 is the oldest.')).toEqual([]);
  });

  it('sits in the role:chat and public:report cells (criterion 35)', () => {
    for (const [audience, intent] of [
      [ROLE_HOLDER, 'chat'],
      [NO_ROLE, 'report'],
    ] as const) {
      const cell = cellFor(audience, intent);
      expect(cell?.rules.map((r) => r.id)).toContain('issue-link-shape');
    }
  });
});
